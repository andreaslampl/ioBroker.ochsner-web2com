# ioBroker.ochsner-web2com

ioBroker adapter for Ochsner heat pumps via the web2com gateway. No official interface: the
gateway's own SOAP API was found out by the owner in Node-RED (flow export, contains the owner's IP -
never commit it). The adapter replaces that flow, incl. forwarding to KNX.

## Layout

- `lib/web2com.js` – `Web2Com`: POST `http://<host>/ws`, Digest auth (`lib/http-client.js`, copy of
  ioBroker.livecam's), namespace `http://ws01.lom.ch/soap/`. Read: `getDpRequest` {ref.oid, startIndex 0,
  count 1} -> first `dpCfg` {index, name, desc, value, unit}. Write: `writeDpRequest` {ref.oid, dp.index =
  last OID part, value, timestamp 0}. Requests serialized. Parsing by regex (no XML dependency).
- `lib/datapoints.js` – default table = the owner's Node-RED flow (20 OIDs, status/mode texts from its
  function nodes), `cleanTable()` (id = slug of the name).
- `main.js` – poll loop (stops a round on login/network errors), states `values.<slug>` (lists = number
  + common.states), writes only for `write` data points with value checks (list keys, min/max), read
  back after 2/5/10/20/40 s (`readBackMs` base, tests use 50) while `holdUntil` keeps the commanded value, `out` mirror (on change, `outText` = text), `in` foreign state -> write (own writes
  ignored via state.from), sendTo `read` for the admin "OID lesen" button. Unit/name of the gateway
  stored in the object on the first read.
- `test/` – `node --test`; `fake.js` = fake web2com (SOAP + Digest MD5/qop) and fake adapter-core.

## Status

- 0.1.0: built from the flow only; not yet tested against the owner's real web2com. Open: whether
  dpCfg really carries name/unit, whether the gateway accepts our envelope exactly (the flow's write
  template had no <name/>/<prop/> tags in some places - both variants were used there).
- 0.1.1: owner says there is cooling too (not in the flow, OIDs unknown) -> "OID lesen" reads a group
  (getDpRequest count 30, the flow used count 10 too) and lists OID/name/value/unit to find them.
- 0.1.1 field: installed on the owner's ioBroker; first try with the right IP: 401 "Anmeldung abgelehnt"
  (credentials or digest variant?) -> 0.1.2 logs the WWW-Authenticate challenge (nonce masked).
- 0.1.3 field: reading works on the owner's real web2com (values in the objects); the 401 earlier was
  wrong credentials. Writing and KNX forwarding not yet confirmed.
- 0.1.3 field: "connected" stayed red and a mode change "was not accepted": the real web2com is slow
  (debug log 0.1.4: 0.3-0.7 s per request, a round of 20 ~9 s); connection was set only after the round, and the write
  waited behind the poll reads, which then put the old value back. 0.1.4: priority queue in Web2Com
  (writes + read back first), `holdUntil` (15 s) keeps poll answers from overwriting a commanded
  value, connection true at the first value, debug log per request with time, warning when the read
  back differs from the written value.
- 0.1.4 field: still not "connected": `this.connected` is adapter-core's own DB connection flag (always
  true) -> renamed to `gwConnected` in 0.1.5; the fake adapter now has `connected = true` like the real one.
- 0.1.5 field: connected works. Writing "0" (Standby) to /1/3/4/107/0 worked; writing "4" (Normal) did
  not - the owner confirms the heat pump stayed in Standby. 0.1.6 reads back up to 40 s (harmless, but a
  delay was not the cause). Open: why 4 is refused (write response body is in the debug log).
- Mode codes for the heating circuits are a union of the flow's texts (0 Standby, 1 Automatik,
  3 Nachheizbetrieb, 4 Normal, 5 Spar, 7 Hand Heizen); 2 for the circuits is unknown.

## Conventions

- UI texts and README in German, code and comments in English.
- Bump `version` in both `package.json` and `io-package.json` and add a `news` entry.
- Install on the ioBroker host: `iobroker url https://github.com/andreaslampl/ioBroker.ochsner-web2com`.
- Run `npm test` before committing.
- Don't put the owner's IP addresses in the repository (use x.x.x.x / 192.168.1.x examples).
