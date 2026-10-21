'use strict';

/*
 * Ochsner web2com gateway: SOAP over HTTP POST /ws with Digest authentication (as found out in the
 * owner's Node-RED flow). Data points are addressed by OIDs like /1/3/4/119/1 - the last part is the
 * index inside the group.
 *   read:  getDpRequest  {ref: {oid}, startIndex: 0, count: 1} -> getDpResponse {ref, dpCfg[]: {index, name,
 *          prop, desc, value, unit, timestamp}} - the first dpCfg is the asked data point
 *   write: writeDpRequest {ref: {oid}, dp: {index: <last OID part>, value, timestamp: 0}}
 * Requests run one after the other (small gateway).
 */

const { HttpClient } = require('./http-client');

const NS = [
    'xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/"',
    'xmlns:SOAP-ENC="http://schemas.xmlsoap.org/soap/encoding/"',
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
    'xmlns:xsd="http://www.w3.org/2001/XMLSchema"',
    'xmlns:ns="http://ws01.lom.ch/soap/"',
].join(' ');

const OID = /^(\/\d+){3,8}$/;

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unesc = s =>
    String(s)
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)))
        .replace(/&amp;/g, '&');

function envelope(body) {
    return `<?xml version="1.0" encoding="UTF-8"?>\n<SOAP-ENV:Envelope ${NS}><SOAP-ENV:Body>${body}</SOAP-ENV:Body></SOAP-ENV:Envelope>`;
}

function readRequest(oid, count = 1) {
    return envelope(`<ns:getDpRequest><ref><oid>${esc(oid)}</oid><prop/></ref><startIndex>0</startIndex><count>${count}</count></ns:getDpRequest>`);
}

function writeRequest(oid, value) {
    const index = oid.split('/').pop();
    return envelope(
        `<ns:writeDpRequest><ref><oid>${esc(oid)}</oid><prop/></ref><dp><index>${index}</index><name/><prop/><desc/><value>${esc(value)}</value><unit/><timestamp>0</timestamp></dp></ns:writeDpRequest>`,
    );
}

/** Text of an element (any namespace prefix), or undefined. */
function tag(xml, name) {
    const m = new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>)`).exec(xml);
    return m ? unesc(m[1] === undefined ? '' : m[1].trim()) : undefined;
}

/** SOAP fault or gateway error text, or null. */
function fault(xml) {
    if (/<(?:[\w-]+:)?Fault[\s>]/.test(xml)) {
        return tag(xml, 'faultstring') || tag(xml, 'detail') || 'SOAP-Fehler';
    }
    return null;
}

/** getDpResponse -> list of {index, name, desc, value, unit, prop, timestamp} */
function parseRead(xml) {
    const err = fault(xml);
    if (err) {
        throw new Error(err);
    }
    const list = [];
    const re = /<(?:[\w-]+:)?dpCfg(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w-]+:)?dpCfg>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
        const b = m[1];
        list.push({
            index: tag(b, 'index'),
            name: tag(b, 'name') || '',
            desc: tag(b, 'desc') || '',
            value: tag(b, 'value'),
            unit: tag(b, 'unit') || '',
            prop: tag(b, 'prop') || '',
            timestamp: tag(b, 'timestamp'),
        });
    }
    if (!list.length) {
        throw new Error('Antwort ohne Wert (dpCfg fehlt)');
    }
    return list;
}

class Web2Com {
    /**
     * @param {object} o
     * @param {string} o.host address of the web2com (IP or name, optional http(s):// and port)
     */
    constructor({ host, user, password, timeout = 10000, log }) {
        const h = String(host || '').trim().replace(/\/+$/, '');
        this.url = `${/^https?:\/\//.test(h) ? h : `http://${h}`}/ws`;
        this.client = new HttpClient({ user, password, timeout });
        this.log = log;
        this.queue = Promise.resolve();
    }

    /** Run requests one after the other. */
    _serial(fn) {
        const run = this.queue.then(fn, fn);
        this.queue = run.catch(() => {});
        return run;
    }

    async _post(xml) {
        const res = await this.client.request(this.url, { method: 'POST', body: xml, headers: { 'Content-Type': 'text/xml; charset=utf-8' } });
        const text = res.body.toString('utf8');
        if (res.status === 401) {
            throw new Error('Anmeldung abgelehnt (Benutzer/Passwort prüfen)');
        }
        if (res.status !== 200) {
            throw new Error(fault(text) || `HTTP ${res.status}`);
        }
        return text;
    }

    /** Read one data point: {oid, value, name, unit, desc}. */
    read(oid) {
        if (!OID.test(oid)) {
            return Promise.reject(new Error(`Ungültige OID: ${oid}`));
        }
        return this._serial(async () => {
            const dp = parseRead(await this._post(readRequest(oid)))[0];
            return { oid, ...dp };
        });
    }

    /**
     * Several data points of a group from an OID on (e.g. /1/3/4/107/0 -> indexes 0, 1, 2 …) with their
     * names - to find OIDs. [{oid, index, name, value, unit, desc}]
     */
    readGroup(oid, count = 30) {
        if (!OID.test(oid)) {
            return Promise.reject(new Error(`Ungültige OID: ${oid}`));
        }
        const base = oid.split('/').slice(0, -1).join('/');
        return this._serial(async () => {
            const list = parseRead(await this._post(readRequest(oid, count)));
            const first = Number(oid.split('/').pop());
            return list.map((dp, i) => {
                const index = dp.index !== undefined && dp.index !== '' ? dp.index : String(first + i);
                return { oid: `${base}/${index}`, ...dp, index };
            });
        });
    }

    /** Write one data point. */
    write(oid, value) {
        if (!OID.test(oid)) {
            return Promise.reject(new Error(`Ungültige OID: ${oid}`));
        }
        return this._serial(async () => {
            const err = fault(await this._post(writeRequest(oid, value)));
            if (err) {
                throw new Error(err);
            }
        });
    }
}

module.exports = { Web2Com, readRequest, writeRequest, parseRead, fault, tag, OID };
