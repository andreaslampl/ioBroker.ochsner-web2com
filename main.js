'use strict';

const utils = require('@iobroker/adapter-core');
const { Web2Com } = require('./lib/web2com');
const { cleanTable } = require('./lib/datapoints');

/** Value from the gateway (text) -> ioBroker value. */
function fromGateway(dp, text) {
    const n = Number(String(text).trim().replace(',', '.'));
    if (dp.kind === 'bool') {
        return Number.isFinite(n) ? n !== 0 : /^(true|on|ein)$/i.test(String(text).trim());
    }
    return Number.isFinite(n) ? n : null;
}

/** ioBroker value -> value for the gateway, or an error text. */
function toGateway(dp, val) {
    if (dp.kind === 'bool') {
        return { value: val === true || val === 1 || val === 'true' || val === '1' ? '1' : '0' };
    }
    let n = typeof val === 'boolean' ? Number(val) : Number(String(val).trim().replace(',', '.'));
    if (dp.kind === 'list' && !Number.isFinite(n) && dp.states) {
        // a text like "Automatik" (e.g. from a KNX text object or a script)
        const hit = Object.entries(dp.states).find(([, t]) => t.toLowerCase() === String(val).trim().toLowerCase());
        n = hit ? Number(hit[0]) : NaN;
    }
    if (!Number.isFinite(n)) {
        return { error: `keine Zahl: ${val}` };
    }
    if (dp.kind === 'list' && dp.states && Object.keys(dp.states).length && !(String(n) in dp.states)) {
        return { error: `Wert ${n} nicht erlaubt (${Object.keys(dp.states).join(', ')})` };
    }
    if ((dp.min !== undefined && n < dp.min) || (dp.max !== undefined && n > dp.max)) {
        return { error: `Wert ${n} außerhalb ${dp.min ?? '…'}–${dp.max ?? '…'}` };
    }
    return { value: String(Math.round(n * 100) / 100) };
}

class OchsnerWeb2com extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 'ochsner-web2com' });
        this.dps = [];
        this.byOid = new Map();
        this.last = new Map(); // dp id -> last value set
        this.mirrored = new Map(); // out state -> last value sent
        this.errors = new Map(); // oid -> last error text (log once)
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        await this.setState('info.connection', false, true);
        this.dps = cleanTable(this.config.datapoints, this.log);
        const host = String(this.config.host || '').trim();
        if (!host) {
            this.log.error('Address of the web2com is missing (instance settings)');
            return;
        }
        this.gw = new Web2Com({ host, user: String(this.config.user || ''), password: String(this.config.password || ''), timeout: 10000, log: this.log });
        await this.createObjects();
        this.subscribeStates('values.*');
        for (const dp of this.dps) {
            if (dp.in && dp.write) {
                await this.subscribeForeignStatesAsync(dp.in);
            } else if (dp.in) {
                this.log.warn(`${dp.name}: input ${dp.in} ignored - the data point is not marked as writable`);
            }
        }
        this.log.info(`web2com ${host}: ${this.dps.length} data points, every ${this.interval / 1000} s`);
        this.poll();
    }

    get interval() {
        return Math.max(10, Number(this.config.interval) || 60) * 1000;
    }

    async createObjects() {
        await this.extendObject('values', { type: 'channel', common: { name: 'Werte der Wärmepumpe' }, native: {} });
        const keep = new Set();
        for (const dp of this.dps) {
            keep.add(`${this.namespace}.values.${dp.id}`);
            const temp = dp.unit === '°C';
            let role = 'value';
            if (dp.kind === 'bool') {
                role = dp.write ? 'switch' : 'indicator';
            } else if (dp.kind === 'list') {
                role = dp.write ? 'level.mode' : 'value.mode';
            } else if (temp) {
                role = dp.write ? 'level.temperature' : 'value.temperature';
            } else if (dp.write) {
                role = 'level';
            }
            const common = {
                name: dp.name,
                type: dp.kind === 'bool' ? 'boolean' : 'number',
                role,
                read: true,
                write: dp.write,
                unit: dp.unit || undefined,
                desc: `web2com ${dp.oid}`,
            };
            if (dp.states && Object.keys(dp.states).length) {
                common.states = dp.states;
            }
            if (dp.min !== undefined) {
                common.min = dp.min;
            }
            if (dp.max !== undefined) {
                common.max = dp.max;
            }
            await this.extendObject(`values.${dp.id}`, { type: 'state', common, native: { oid: dp.oid } });
            this.byOid.set(dp.oid, dp);
        }
        // data points removed from the table
        const objs = await this.getAdapterObjectsAsync();
        for (const id of Object.keys(objs)) {
            if (id.startsWith(`${this.namespace}.values.`) && !keep.has(id)) {
                await this.delObjectAsync(id);
                this.log.info(`Removed ${id} (no longer in the table)`);
            }
        }
    }

    async poll() {
        clearTimeout(this.timer);
        let ok = 0;
        let failed = 0;
        for (const dp of this.dps) {
            if (this.stopped) {
                return;
            }
            try {
                await this.readDp(dp);
                ok++;
            } catch (err) {
                failed++;
                if (this.errors.get(dp.oid) !== err.message) {
                    this.errors.set(dp.oid, err.message);
                    this.log.warn(`${dp.name} (${dp.oid}): ${err.message}`);
                }
                if (/Anmeldung|ECONNREFUSED|EHOSTUNREACH|ETIMEDOUT|Timeout|ENOTFOUND/.test(err.message)) {
                    break; // gateway not reachable: no point asking the rest now
                }
            }
        }
        this.log.debug(`Poll round: ${ok} ok, ${failed} failed`);
        if (!ok && failed && this.gwConnected !== false) {
            this.gwConnected = false;
            await this.setState('info.connection', false, true);
        }
        await this.setState('info.lastPoll', Date.now(), true);
        if (!this.stopped) {
            this.timer = setTimeout(() => this.poll(), this.interval);
        }
    }

    /** urgent: read back after a command (before the poll reads, and it may update a held value). */
    async readDp(dp, urgent = false) {
        const r = await this.gw.read(dp.oid, { urgent });
        if (!this.gwConnected) {
            this.gwConnected = true;
            await this.setState('info.connection', true, true);
            this.log.info('web2com connected');
        }
        if (this.errors.has(dp.oid)) {
            this.errors.delete(dp.oid);
            this.log.info(`${dp.name}: readable again`);
        }
        const val = fromGateway(dp, r.value);
        if (!dp.gwInfo) {
            dp.gwInfo = true;
            // name and unit of the gateway: shown in the object, unit used if none is set
            const common = { desc: `web2com ${dp.oid}${r.name ? ` – ${r.name}` : ''}` };
            if (!dp.unit && r.unit && dp.kind === 'number') {
                common.unit = r.unit;
            }
            await this.extendObject(`values.${dp.id}`, { common, native: { oid: dp.oid, gwName: r.name, gwUnit: r.unit, gwDesc: r.desc } });
        }
        if (!urgent && dp.holdUntil > Date.now()) {
            // a command is on its way: an older poll answer must not undo it in the object
            return val;
        }
        this.last.set(dp.id, val);
        await this.setState(`values.${dp.id}`, { val, ack: true });
        await this.mirror(dp, val);
        return val;
    }

    /** Copy the value to the output state (e.g. KNX), only when it changed. */
    async mirror(dp, val) {
        if (!dp.out) {
            return;
        }
        const v = dp.outText && dp.states ? (dp.states[String(val)] ?? String(val)) : val;
        if (this.mirrored.get(dp.out) === v) {
            return;
        }
        this.mirrored.set(dp.out, v);
        await this.setForeignStateAsync(dp.out, v, false).catch(err => this.log.warn(`${dp.name} -> ${dp.out}: ${err.message}`));
    }

    async onStateChange(id, state) {
        if (!state) {
            return;
        }
        if (id.startsWith(`${this.namespace}.values.`)) {
            if (state.ack) {
                return;
            }
            const dp = this.dps.find(d => id === `${this.namespace}.values.${d.id}`);
            if (dp) {
                await this.command(dp, state.val, 'ioBroker');
            }
            return;
        }
        // input state (e.g. KNX): ignore what this adapter wrote itself
        if (state.from === `system.adapter.${this.namespace}`) {
            return;
        }
        for (const dp of this.dps.filter(d => d.in === id && d.write)) {
            await this.command(dp, state.val, id);
        }
    }

    /** Write a value to the heat pump, then read it back. */
    async command(dp, val, from) {
        if (!dp.write) {
            this.log.warn(`${dp.name} is not writable (instance settings)`);
            await this.setState(`values.${dp.id}`, { val: this.last.has(dp.id) ? this.last.get(dp.id) : null, ack: true });
            return;
        }
        const conv = toGateway(dp, val);
        if (conv.error) {
            this.log.warn(`${dp.name}: ${conv.error} (from ${from})`);
            await this.setState(`values.${dp.id}`, { val: this.last.has(dp.id) ? this.last.get(dp.id) : null, ack: true });
            return;
        }
        dp.holdUntil = Date.now() + 15000;
        try {
            await this.gw.write(dp.oid, conv.value);
            this.log.info(`${dp.name} = ${conv.value}${dp.states && dp.states[conv.value] ? ` (${dp.states[conv.value]})` : ''} (from ${from})`);
        } catch (err) {
            this.log.warn(`${dp.name}: write failed: ${err.message}`);
        }
        // the heat pump takes a moment; read back what it really has
        clearTimeout(dp.readBack);
        dp.readBack = setTimeout(
            () =>
                this.readDp(dp, true)
                    .then(v => {
                        dp.holdUntil = 0;
                        if (String(v === true ? 1 : v === false ? 0 : v) !== conv.value) {
                            this.log.warn(`${dp.name}: the heat pump reports ${v} after writing ${conv.value} - not accepted (or not yet)`);
                        }
                    })
                    .catch(err => this.log.warn(`${dp.name}: ${err.message}`)),
            Number(this.config.readBackMs) || 1500,
        );
    }

    /** Admin: "OID testen" - read any OID and show name, value and unit. */
    async onMessage(obj) {
        if (!obj || obj.command !== 'read' || !obj.callback) {
            return;
        }
        const oid = String((obj.message && obj.message.oid) || '').trim();
        let result;
        try {
            if (!this.gw) {
                throw new Error('Adapter läuft nicht (Adresse fehlt?)');
            }
            // the whole group from this OID on, with the names the web2com knows (to find OIDs)
            const list = await this.gw.readGroup(oid, 30);
            const lines = list.map(r => `${r.oid}: ${r.value}${r.unit ? ` ${r.unit}` : ''}${r.name ? ` – ${r.name}` : ''}${r.desc ? ` (${r.desc})` : ''}`);
            this.log.info(`OID lesen ${oid}:\n${lines.join('\n')}`);
            result = { result: lines.join('\n') };
        } catch (err) {
            result = { error: `${oid}: ${err.message}` };
        }
        this.sendTo(obj.from, obj.command, result, obj.callback);
    }

    onUnload(callback) {
        this.stopped = true;
        clearTimeout(this.timer);
        for (const dp of this.dps) {
            clearTimeout(dp.readBack);
        }
        this.setState('info.connection', false, true)
            .catch(() => {})
            .finally(() => callback());
    }
}

if (require.main !== module) {
    module.exports = options => new OchsnerWeb2com(options);
} else {
    new OchsnerWeb2com();
}

module.exports.fromGateway = fromGateway;
module.exports.toGateway = toGateway;
