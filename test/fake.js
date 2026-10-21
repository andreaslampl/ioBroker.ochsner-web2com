'use strict';

/* Test helpers: a fake web2com (SOAP + Digest like the real gateway) and a fake ioBroker adapter-core. */

const http = require('node:http');
const crypto = require('node:crypto');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

/** Fake web2com: values by OID, Digest auth (MD5, qop=auth), getDp/writeDp. */
function fakeGateway({ values, user = 'admin', password = 'geheim', names = {} }) {
    const gw = { values, writes: [], requests: 0, authFailures: 0 };
    const realm = 'web2com';
    const nonce = crypto.randomBytes(8).toString('hex');
    const md5 = s => crypto.createHash('md5').update(s).digest('hex');
    gw.server = http.createServer((req, res) => {
        let body = '';
        req.on('data', c => (body += c));
        req.on('end', () => {
            gw.requests++;
            const auth = req.headers.authorization || '';
            const p = {};
            auth.replace(/(\w+)=(?:"([^"]*)"|([^\s,]+))/g, (m, k, a, b) => (p[k] = a !== undefined ? a : b));
            const ha1 = md5(`${user}:${realm}:${password}`);
            const ha2 = md5(`${req.method}:${p.uri}`);
            const ok = /^Digest /.test(auth) && p.username === user && p.response === md5(`${ha1}:${nonce}:${p.nc}:${p.cnonce}:${p.qop}:${ha2}`);
            if (!ok) {
                if (auth) {
                    gw.authFailures++;
                }
                res.writeHead(401, { 'WWW-Authenticate': `Digest realm="${realm}", qop="auth", nonce="${nonce}", algorithm=MD5` });
                res.end();
                return;
            }
            if (req.url !== '/ws') {
                res.writeHead(404);
                res.end();
                return;
            }
            const oid = (/<oid>([^<]*)<\/oid>/.exec(body) || [])[1];
            const env = inner =>
                `<?xml version="1.0" encoding="UTF-8"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns="http://ws01.lom.ch/soap/"><SOAP-ENV:Body>${inner}</SOAP-ENV:Body></SOAP-ENV:Envelope>`;
            res.writeHead(200, { 'Content-Type': 'text/xml' });
            if (!(oid in gw.values)) {
                res.end(env(`<SOAP-ENV:Fault><faultcode>SOAP-ENV:Client</faultcode><faultstring>invalid oid ${oid}</faultstring></SOAP-ENV:Fault>`));
                return;
            }
            if (body.includes('getDpRequest')) {
                const index = oid.split('/').pop();
                const n = names[oid] || { name: 'Wert', unit: '' };
                res.end(
                    env(
                        `<ns:getDpResponse><ref><oid>${oid}</oid><prop>rw</prop></ref><dpCfg><index>${index}</index><name>${n.name}</name><prop>rw</prop><desc>${n.desc || ''}</desc><value>${gw.values[oid]}</value><unit>${n.unit}</unit><timestamp>0</timestamp></dpCfg></ns:getDpResponse>`,
                    ),
                );
                return;
            }
            if (body.includes('writeDpRequest')) {
                const value = (/<value>([^<]*)<\/value>/.exec(body) || [])[1];
                const index = (/<index>([^<]*)<\/index>/.exec(body) || [])[1];
                gw.writes.push({ oid, value, index });
                gw.values[oid] = value;
                res.end(env('<ns:writeDpResponse><result>0</result></ns:writeDpResponse>'));
                return;
            }
            res.end(env('<SOAP-ENV:Fault><faultstring>unknown request</faultstring></SOAP-ENV:Fault>'));
        });
    });
    gw.listen = () => new Promise(r => gw.server.listen(0, '127.0.0.1', () => r(`127.0.0.1:${gw.server.address().port}`)));
    gw.close = () => new Promise(r => gw.server.close(() => r()));
    return gw;
}

class FakeAdapter extends EventEmitter {
    constructor(options) {
        super();
        this.namespace = `${options.name}.0`;
        this.config = options.config;
        this.states = {}; // own and foreign: full id -> {val, ack, from}
        this.objects = {};
        this.subs = new Set();
        this.sent = [];
        this.logs = [];
        const log = level => m => this.logs.push(`${level}: ${m}`);
        this.log = { debug() {}, info: log('info'), warn: log('warn'), error: log('error') };
    }
    _id(id) {
        return id.startsWith(`${this.namespace}.`) ? id : `${this.namespace}.${id}`;
    }
    async setState(id, val, ack) {
        const st = val && typeof val === 'object' ? val : { val, ack };
        this.states[this._id(id)] = { val: st.val, ack: Boolean(st.ack), from: `system.adapter.${this.namespace}` };
    }
    async setForeignStateAsync(id, val, ack) {
        this.states[id] = { val, ack: Boolean(ack), from: `system.adapter.${this.namespace}` };
        if (this.subs.has(id)) {
            setImmediate(() => this.emit('stateChange', id, this.states[id]));
        }
    }
    async extendObject(id, obj) {
        const full = this._id(id);
        const old = this.objects[full] || {};
        this.objects[full] = { ...old, ...obj, common: { ...(old.common || {}), ...(obj.common || {}) }, native: { ...(old.native || {}), ...(obj.native || {}) } };
    }
    async getAdapterObjectsAsync() {
        return { ...this.objects };
    }
    async delObjectAsync(id) {
        delete this.objects[this._id(id)];
    }
    subscribeStates() {}
    async subscribeForeignStatesAsync(id) {
        this.subs.add(id);
    }
    sendTo(to, command, message, callback) {
        this.sent.push({ to, command, message });
        if (typeof callback === 'function') {
            callback(message);
        }
    }
    /** a user or another adapter (e.g. KNX) changes a state */
    change(id, val, ack = false, from = 'system.adapter.knx.0') {
        const full = id.includes('.') && !id.startsWith('values.') ? id : this._id(id);
        this.states[full] = { val, ack, from };
        setImmediate(() => this.emit('stateChange', full, this.states[full]));
    }
}

function install() {
    const orig = Module._load;
    Module._load = function (request, ...rest) {
        if (request === '@iobroker/adapter-core') {
            return { Adapter: FakeAdapter };
        }
        return orig.call(this, request, ...rest);
    };
}

async function until(fn, ms = 5000) {
    const end = Date.now() + ms;
    while (!(await fn())) {
        if (Date.now() > end) {
            throw new Error('timeout');
        }
        await new Promise(r => setTimeout(r, 20));
    }
}

module.exports = { fakeGateway, FakeAdapter, install, until };
