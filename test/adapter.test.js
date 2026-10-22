'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeGateway, install, until } = require('./fake');
const { readRequest, writeRequest, parseRead } = require('../lib/web2com');
const io = require('../io-package.json');

install();

const VALUES = {
    '/1/2/1/125/0': '1',
    '/1/2/1/125/7': '6.4',
    '/1/2/1/125/8': '12.75',
    '/1/2/7/107/0': '1',
    '/1/2/7/121/1': '48.5',
    '/1/3/4/119/1': '-3.2',
    '/1/3/4/107/0': '1',
    '/1/3/4/119/0': '1',
    '/1/3/4/119/3': '21.8',
    '/1/3/4/119/7': '44',
    '/1/3/4/108/4': '21',
    '/1/3/4/119/5': '31.5',
    '/1/3/4/117/0': '1',
    '/1/3/4/117/1': '0',
    '/1/3/5/107/0': '4',
    '/1/3/5/119/0': '0',
    '/1/3/5/108/4': '19.5',
    '/1/3/5/119/4': '38',
    '/1/3/5/117/0': '0',
    '/1/3/5/117/1': '0',
    '/1/9/9/9/9': '7',
};

test('SOAP requests look like the ones of the Node-RED flow', () => {
    const r = readRequest('/1/3/4/119/1');
    assert.match(r, /<ns:getDpRequest><ref><oid>\/1\/3\/4\/119\/1<\/oid>/);
    assert.match(r, /<startIndex>0<\/startIndex><count>1<\/count>/);
    assert.match(r, /xmlns:ns="http:\/\/ws01\.lom\.ch\/soap\/"/);
    const w = writeRequest('/1/3/4/108/4', '21.5');
    assert.match(w, /<ns:writeDpRequest><ref><oid>\/1\/3\/4\/108\/4<\/oid>/);
    assert.match(w, /<dp><index>4<\/index>.*<value>21\.5<\/value>.*<timestamp>0<\/timestamp><\/dp>/);
    const parsed = parseRead(
        '<SOAP-ENV:Envelope><SOAP-ENV:Body><ns:getDpResponse><ref><oid>/1/2/7/121/1</oid></ref><dpCfg><index>1</index><name>WW Ist</name><value>48.5</value><unit>&#176;C</unit></dpCfg></ns:getDpResponse></SOAP-ENV:Body></SOAP-ENV:Envelope>',
    );
    assert.deepEqual([parsed[0].name, parsed[0].value, parsed[0].unit], ['WW Ist', '48.5', '°C']);
    assert.throws(() => parseRead('<SOAP-ENV:Fault><faultstring>invalid oid</faultstring></SOAP-ENV:Fault>'), /invalid oid/);
});

async function start(t, config = {}, gwOpts = {}) {
    const gw = fakeGateway({ values: { ...VALUES }, names: { '/1/2/1/125/8': { name: 'Wärmemenge', unit: 'MWh' } }, ...gwOpts });
    const host = await gw.listen();
    const datapoints = io.native.datapoints.map(d => ({ ...d }));
    // like the owner's KNX: outside temperature and DHW status out, DHW mode in
    datapoints.find(d => d.name === 'Außentemperatur').out = 'knx.0.Aussentemperatur';
    Object.assign(datapoints.find(d => d.name === 'Warmwasser Betriebsart'), { out: 'knx.0.WW_Status', outText: true, in: 'knx.0.WW_Betriebsart' });
    datapoints.push({ oid: '/1/9/9/9/8', name: 'Gibt es nicht', kind: 'number' });
    const adapter = require('../main.js')({ config: { host, user: 'admin', password: 'geheim', interval: 10, readBackMs: 50, datapoints, ...config } });
    adapter.emit('ready');
    t.after(async () => {
        await new Promise(r => adapter.emit('unload', r));
        await gw.close();
    });
    return { adapter, gw };
}

test('adapter: reads all data points, writes modes and set point, forwards to KNX', async t => {
    const { adapter, gw } = await start(t);
    const st = id => adapter.states[`ochsner-web2com.0.values.${id}`];
    await until(() => adapter.states['ochsner-web2com.0.info.lastPoll']);
    assert.equal(adapter.states['ochsner-web2com.0.info.connection'].val, true);
    assert.equal(st('aussentemperatur').val, -3.2);
    assert.equal(st('warmwasser_temperatur').val, 48.5);
    assert.equal(st('pumpe_fussbodenheizung').val, true);
    assert.equal(st('heizkoerper_betriebsart').val, 4);
    // objects: texts for lists, unit from the gateway when none is set, OID in the description
    const obj = id => adapter.objects[`ochsner-web2com.0.values.${id}`];
    assert.equal(obj('waermeerzeuger_status').common.states['1'], 'Heizbetrieb');
    assert.equal(obj('waermeleistung_mw').common.unit, 'MWh');
    assert.match(obj('waermeleistung_mw').common.desc, /\/1\/2\/1\/125\/8 – Wärmemenge/);
    assert.equal(obj('raumtemperatur_soll').common.write, true);
    assert.equal(obj('aussentemperatur').common.write, false);
    assert.ok(adapter.logs.some(l => /Gibt es nicht.*invalid oid/.test(l)), 'unknown OID logged');

    // KNX out: value and status text
    assert.equal(adapter.states['knx.0.Aussentemperatur'].val, -3.2);
    assert.equal(adapter.states['knx.0.WW_Status'].val, 'Automatik');

    // ioBroker: operating mode Normal (2) -> writeDp with index 0, read back, KNX text follows
    adapter.change('values.warmwasser_betriebsart', 2);
    await until(() => gw.writes.length === 1);
    assert.deepEqual(gw.writes[0], { oid: '/1/2/7/107/0', value: '2', index: '0' });
    await until(() => st('warmwasser_betriebsart').ack && st('warmwasser_betriebsart').val === 2);
    await until(() => adapter.states['knx.0.WW_Status'].val === 'Normal');

    // not allowed: value not in the list, set point out of range, read-only data point
    adapter.change('values.warmwasser_betriebsart', 9);
    adapter.change('values.raumtemperatur_soll', 35);
    adapter.change('values.aussentemperatur', 10);
    await until(() => adapter.logs.filter(l => /nicht erlaubt|außerhalb|not writable/.test(l)).length >= 3);
    assert.equal(gw.writes.length, 1);
    assert.equal(st('warmwasser_betriebsart').val, 2, 'reset to the real value');

    // set point like the Node-RED flow: index 4 of /1/3/4/108/4
    adapter.change('values.raumtemperatur_soll', 21.5);
    await until(() => gw.writes.length === 2);
    assert.deepEqual(gw.writes[1], { oid: '/1/3/4/108/4', value: '21.5', index: '4' });

    // KNX in: scene/number from the bus, also the text works; own writes are ignored
    adapter.change('knx.0.WW_Betriebsart', 0, true);
    await until(() => gw.writes.length === 3);
    assert.equal(gw.writes[2].value, '0');
    adapter.change('knx.0.WW_Betriebsart', 'Automatik', true);
    await until(() => gw.writes.length === 4);
    assert.equal(gw.writes[3].value, '1');
    adapter.change('knx.0.WW_Betriebsart', 2, false, 'system.adapter.ochsner-web2com.0');
    await new Promise(r => setTimeout(r, 200));
    assert.equal(gw.writes.length, 4);

    // admin: read any OID
    adapter.emit('message', { command: 'read', from: 'system.adapter.admin.0', message: { oid: '/1/2/1/125/7' }, callback: { id: 1 } });
    await until(() => adapter.sent.some(s => s.command === 'read'));
    // the group from this OID on, with names: here 125/7 and 125/8
    const lines = adapter.sent.find(s => s.command === 'read').message.result.split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^\/1\/2\/1\/125\/7: 6\.4/);
    assert.match(lines[1], /^\/1\/2\/1\/125\/8: 12\.75 MWh – Wärmemenge/);
});

test('address with or without http:// and /ws (as copied from Node-RED)', () => {
    const { Web2Com } = require('../lib/web2com');
    for (const host of ['192.168.1.5', 'http://192.168.1.5', 'http://192.168.1.5/ws', 'http://192.168.1.5/ws/']) {
        assert.equal(new Web2Com({ host }).url, 'http://192.168.1.5/ws', host);
    }
});

test('adapter: wrong password -> not connected, clear message', async t => {
    const { adapter, gw } = await start(t, { password: 'falsch' });
    await until(() => adapter.states['ochsner-web2com.0.info.lastPoll']);
    assert.equal(adapter.states['ochsner-web2com.0.info.connection'].val, false);
    assert.ok(adapter.logs.some(l => /Anmeldung abgelehnt/.test(l)));
    assert.ok(gw.requests < 5, 'stops asking after the login failed');
});

test('slow web2com: connected at the first value, a command goes first and is not undone by the poll', async t => {
    const { adapter, gw } = await start(t, {}, { delay: 80 });
    const st = id => adapter.states[`ochsner-web2com.0.values.${id}`];
    // connected long before the round of 21 reads (~3.5 s) is over
    await until(() => adapter.states['ochsner-web2com.0.info.connection'] && adapter.states['ochsner-web2com.0.info.connection'].val === true, 1500);
    assert.ok(!adapter.states['ochsner-web2com.0.info.lastPoll'], 'round still running');
    // the floor heating mode is read late in the round; the command comes before it
    adapter.change('values.fussbodenheizung_betriebsart', 0);
    await until(() => gw.writes.length === 1, 1500);
    assert.equal(gw.writes[0].oid, '/1/3/4/107/0');
    // until the round is over the object must stay at the new value (ack after the read back)
    await until(() => adapter.states['ochsner-web2com.0.info.lastPoll'], 8000);
    assert.equal(st('fussbodenheizung_betriebsart').val, 0);
    assert.equal(st('fussbodenheizung_betriebsart').ack, true);
    assert.ok(!adapter.logs.some(l => /not accepted/.test(l)));
});

test('command applied late by the heat pump: kept and confirmed, warning only when never applied', async t => {
    const { adapter, gw } = await start(t, { interval: 10, readBackMs: 50 }, { applyDelay: 300, ignore: ['/1/3/5/107/0'] });
    const st = id => adapter.states[`ochsner-web2com.0.values.${id}`];
    await until(() => adapter.states['ochsner-web2com.0.info.lastPoll']);
    adapter.change('values.fussbodenheizung_betriebsart', 4);
    await until(() => gw.writes.length === 1);
    // the first read back (50 ms) still sees the old value: the object keeps 4 (not yet confirmed)
    await new Promise(r => setTimeout(r, 120));
    assert.equal(st('fussbodenheizung_betriebsart').val, 4);
    // confirmed after the heat pump took it (300 ms)
    await until(() => st('fussbodenheizung_betriebsart').ack && st('fussbodenheizung_betriebsart').val === 4, 2000);
    assert.ok(!adapter.logs.some(l => /not accepted/.test(l)));

    // never applied: warning after the last check (50 ms * 20), then the real value again
    adapter.change('values.heizkoerper_betriebsart', 1);
    await until(() => adapter.logs.some(l => /Heizkörper Betriebsart: the heat pump still reports 4 .* after writing 1 - not accepted/.test(l)), 3000);
    assert.equal(st('heizkoerper_betriebsart').val, 4);
    assert.equal(st('heizkoerper_betriebsart').ack, true);
});

test('after a command the other values of the same circuit are read again at once', async t => {
    const { adapter, gw } = await start(t, { interval: 3600, readBackMs: 50 });
    const st = id => adapter.states[`ochsner-web2com.0.values.${id}`];
    await until(() => adapter.states['ochsner-web2com.0.info.lastPoll']);
    // the heat pump changes its status when the mode is switched; the next poll would be in an hour
    gw.values['/1/3/4/119/0'] = '2';
    gw.values['/1/2/7/121/1'] = '55';
    adapter.change('values.fussbodenheizung_betriebsart', 4);
    await until(() => st('fussbodenheizung_status').val === 2, 2000);
    // other groups (hot water) are not read
    assert.equal(st('warmwasser_temperatur').val, 48.5);
});
