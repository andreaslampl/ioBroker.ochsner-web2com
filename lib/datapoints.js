'use strict';

/*
 * Data point table (instance settings). Defaults = the owner's Node-RED flow. Each entry:
 *   oid     web2com address, e.g. /1/3/4/119/1
 *   name    name in ioBroker (state id is made from it)
 *   kind    number | bool | list (number with texts, e.g. operating modes)
 *   unit    unit (empty: the unit the gateway reports)
 *   texts   list: "0=Standby;1=Automatik" - for writing only these values are allowed
 *   write   may be written from ioBroker
 *   min/max limits for writing numbers
 *   out     optional ioBroker state that gets the value (e.g. a KNX object), outText: the text instead
 *   in      optional ioBroker state whose changes are written to the heat pump (e.g. a KNX object)
 */

const { OID } = require('./web2com');

const DHW_MODE = '0=Standby;1=Automatik;2=Normal;3=Nachheizbetrieb';
const CIRCUIT_MODE = '0=Standby;1=Automatik;3=Nachheizbetrieb;4=Normal;5=Sparbetrieb;7=Handbetrieb Heizen';
const GENERATOR = [
    'Standby',
    'Heizbetrieb',
    'Vorlaufzeit Heizbetrieb',
    'Extern gesperrt',
    'Kühlbetrieb',
    'Vorlaufzeit Kühlbetrieb',
    'Vorlaufzeit Abtaubetrieb',
    'Abtaubetrieb',
    'Störung',
    'Abtropfen',
    'Abtausperrzeit',
]
    .map((t, i) => `${i}=${t}`)
    .join(';');
const CIRCUIT_STATUS = [
    'Standby',
    'Normal Heizbetrieb',
    'Komfort Heizbetrieb',
    'Spar Heizbetrieb',
    'Frostschutzbetrieb',
    'Zwangsabnahme',
    'Zwangsdrosselung',
    'Ferienbetrieb',
    'Partybetrieb',
    'Normal Kühlbetrieb',
    'Komfort Kühlbetrieb',
    'Spar Kühlbetrieb',
    'Störung',
    'Handbetrieb',
    'Schutz Kühlbetrieb',
    'Partybetrieb Kühlen',
    'Austrocknung Aufheizen',
    'Austrocknung Stationär',
    'Austrocknung Auskühlen',
    'Austrocknung Endphase',
    'Nachtlüftung',
    'Belüftung',
    'Kühlbetrieb extern',
    'Heizbetrieb extern',
]
    .map((t, i) => `${i}=${t}`)
    .join(';');

const DEFAULTS = [
    { oid: '/1/2/1/125/0', name: 'Wärmeerzeuger Status', kind: 'list', texts: GENERATOR },
    { oid: '/1/2/1/125/7', name: 'Wärmeleistung kW', kind: 'number', unit: 'kW' },
    { oid: '/1/2/1/125/8', name: 'Wärmeleistung MW', kind: 'number' },
    { oid: '/1/2/7/107/0', name: 'Warmwasser Betriebsart', kind: 'list', texts: DHW_MODE, write: true },
    { oid: '/1/2/7/121/1', name: 'Warmwasser Temperatur', kind: 'number', unit: '°C' },
    { oid: '/1/3/4/119/1', name: 'Außentemperatur', kind: 'number', unit: '°C' },
    { oid: '/1/3/4/107/0', name: 'Fußbodenheizung Betriebsart', kind: 'list', texts: CIRCUIT_MODE, write: true },
    { oid: '/1/3/4/119/0', name: 'Fußbodenheizung Status', kind: 'list', texts: CIRCUIT_STATUS },
    { oid: '/1/3/4/119/3', name: 'Raumtemperatur', kind: 'number', unit: '°C' },
    { oid: '/1/3/4/119/7', name: 'Raumfeuchtigkeit', kind: 'number', unit: '%' },
    { oid: '/1/3/4/108/4', name: 'Raumtemperatur Soll', kind: 'number', unit: '°C', write: true, min: 10, max: 30 },
    { oid: '/1/3/4/119/5', name: 'Vorlauf Fußbodenheizung', kind: 'number', unit: '°C' },
    { oid: '/1/3/4/117/0', name: 'Pumpe Fußbodenheizung', kind: 'bool' },
    { oid: '/1/3/4/117/1', name: 'Mischer Fußbodenheizung', kind: 'number' },
    { oid: '/1/3/5/107/0', name: 'Heizkörper Betriebsart', kind: 'list', texts: CIRCUIT_MODE, write: true },
    { oid: '/1/3/5/119/0', name: 'Heizkörper Status', kind: 'list', texts: CIRCUIT_STATUS },
    { oid: '/1/3/5/108/4', name: 'Raumtemperatur KG', kind: 'number', unit: '°C' },
    { oid: '/1/3/5/119/4', name: 'Vorlauf Heizkörper', kind: 'number', unit: '°C' },
    { oid: '/1/3/5/117/0', name: 'Pumpe Heizkörper', kind: 'bool' },
    { oid: '/1/3/5/117/1', name: 'Mischer Heizkörper', kind: 'number' },
];

/** "0=Standby;1=Automatik" -> {0: 'Standby', 1: 'Automatik'} */
function parseTexts(s) {
    const out = {};
    for (const part of String(s || '').split(';')) {
        const i = part.indexOf('=');
        if (i > 0 && part.slice(0, i).trim() !== '') {
            out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
        }
    }
    return out;
}

function slug(name) {
    return (
        String(name)
            .toLowerCase()
            .replace(/ä/g, 'ae')
            .replace(/ö/g, 'oe')
            .replace(/ü/g, 'ue')
            .replace(/ß/g, 'ss')
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '')
            .slice(0, 50) || 'wert'
    );
}

const num = v => (v === '' || v === null || v === undefined || !Number.isFinite(Number(v)) ? undefined : Number(v));

/** Validate the table from the settings; adds `id` (state id, unique) and `states` (texts map). */
function cleanTable(list, log) {
    const used = new Set();
    const out = [];
    for (const raw of Array.isArray(list) ? list : []) {
        const oid = String((raw && raw.oid) || '').trim();
        if (!oid) {
            continue;
        }
        if (!OID.test(oid)) {
            if (log) {
                log.warn(`Ignoring data point "${raw.name || ''}": invalid OID ${oid}`);
            }
            continue;
        }
        const name = String(raw.name || '').trim() || oid;
        let id = slug(name);
        while (used.has(id)) {
            id += '_2';
        }
        used.add(id);
        const kind = ['number', 'bool', 'list'].includes(raw.kind) ? raw.kind : 'number';
        out.push({
            id,
            oid,
            name,
            kind,
            unit: String(raw.unit || '').trim(),
            texts: kind === 'list' ? String(raw.texts || '') : '',
            states: kind === 'list' ? parseTexts(raw.texts) : null,
            write: Boolean(raw.write),
            min: num(raw.min),
            max: num(raw.max),
            out: String(raw.out || '').trim(),
            outText: Boolean(raw.outText),
            in: String(raw.in || '').trim(),
        });
    }
    return out;
}

module.exports = { DEFAULTS, cleanTable, parseTexts, slug, GENERATOR, CIRCUIT_STATUS, CIRCUIT_MODE, DHW_MODE };
