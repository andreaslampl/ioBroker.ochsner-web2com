# ioBroker.ochsner-web2com

Ochsner-Wärmepumpen über das **web2com**-Gateway im Heimnetz: Werte lesen (Temperaturen, Status,
Pumpen, Leistung) und Betriebsarten bzw. Sollwerte schreiben. Ohne Cloud.

Das web2com hat keine offizielle Schnittstelle; der Adapter spricht dieselbe SOAP-Schnittstelle
(`/ws`), die auch die Weboberfläche verwendet. Herausgefunden wurde sie vom Besitzer in Node-RED –
der Adapter ersetzt diesen Flow.

## Installation

```
iob url https://github.com/andreaslampl/ioBroker.ochsner-web2com
```

Instanz anlegen und einstellen:

| Einstellung | Bedeutung |
| --- | --- |
| Adresse des web2com | IP-Adresse, z. B. `192.168.1.x` |
| Benutzer / Passwort | wie bei der web2com-Weboberfläche |
| Abfrage alle (s) | Standard 60 |

## Datenpunkte

Voreingestellt sind die Werte aus dem Node-RED-Flow; sie erscheinen unter `ochsner-web2com.0.values.*`:

| Name | OID | Art |
| --- | --- | --- |
| Wärmeerzeuger Status | /1/2/1/125/0 | Liste (Standby, Heizbetrieb, Abtaubetrieb, Störung …) |
| Wärmeleistung kW / MW | /1/2/1/125/7, /1/2/1/125/8 | Zahl |
| Warmwasser Betriebsart | /1/2/7/107/0 | **schreibbar**: 0 Standby, 1 Automatik, 2 Normal |
| Warmwasser Temperatur | /1/2/7/121/1 | °C |
| Außentemperatur | /1/3/4/119/1 | °C |
| Fußbodenheizung Betriebsart | /1/3/4/107/0 | **schreibbar**: 0 Standby, 1 Automatik, 4 Normal |
| Fußbodenheizung Status | /1/3/4/119/0 | Liste (Normal/Komfort/Spar Heizbetrieb, Frostschutz …) |
| Raumtemperatur, Raumfeuchtigkeit | /1/3/4/119/3, /1/3/4/119/7 | °C, % |
| Raumtemperatur Soll | /1/3/4/108/4 | **schreibbar**, 10–30 °C |
| Vorlauf Fußbodenheizung / Heizkörper | /1/3/4/119/5, /1/3/5/119/4 | °C |
| Pumpe / Mischer Fußbodenheizung | /1/3/4/117/0, /1/3/4/117/1 | Ein/Aus, Zahl |
| Heizkörper Betriebsart | /1/3/5/107/0 | **schreibbar**: 0 Standby, 1 Automatik, 4 Normal, 5 Spar, 7 Hand |
| Heizkörper Status | /1/3/5/119/0 | Liste |
| Raumtemperatur KG | /1/3/5/108/4 | °C |
| Pumpe / Mischer Heizkörper | /1/3/5/117/0, /1/3/5/117/1 | Ein/Aus, Zahl |

Im Reiter **Datenpunkte** lässt sich die Liste ändern und erweitern (Name, OID, Art, Einheit, Texte,
schreibbar, Min/Max). Geschrieben wird nur, was als **schreibbar** markiert ist; Listen nehmen nur ihre
Werte an, Zahlen nur Werte zwischen Min und Max. Nach dem Schreiben liest der Adapter den Wert zurück.

**Weitere Datenpunkte finden:** im Reiter Verbindung eine OID eingeben und **OID lesen** – die
Antwort zeigt Wert, Einheit und den Namen, den das web2com dafür kennt. Die OIDs stehen z. B. in der
Adresszeile bzw. den Entwicklertools des Browsers, wenn man die web2com-Weboberfläche bedient.

## Weiterleitung an KNX (wie im Node-RED-Flow)

Pro Datenpunkt optional:

- **Ausgang**: ein ioBroker-Datenpunkt, z. B. das KNX-Objekt `knx.0.…` für 1/6/0 Außentemperatur –
  bekommt jeden neuen Wert. Mit **als Text** geht bei Listen der Text statt der Zahl hinaus
  (z. B. für ein KNX-Textobjekt DPT 16, max. 14 Zeichen).
- **Eingang**: ein Datenpunkt, dessen Änderungen an die Wärmepumpe geschrieben werden, z. B. das
  KNX-Objekt für die Betriebsart (Szenennummer 0/1/2). Statt der Zahl geht auch der Text („Automatik“).

Eingang und Ausgang nicht auf denselben Datenpunkt legen (wie schon im Node-RED-Flow vermerkt).

## Changelog

### 0.1.0
- Erste Version: Datenpunkte aus dem Node-RED-Flow, lesen und schreiben, Weiterleitung an KNX-Datenpunkte, OID lesen.

## Lizenz

MIT
