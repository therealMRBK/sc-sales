# sc-sales

Scannt periodisch den [Roberts Space Industries Pledge-Store](https://robertsspaceindustries.com/pledge/ships)
(Star Citizen) und hebt hervor, welche Schiffe im Sale sind — also
entweder im Preis gefallen sind oder normalerweise nicht einzeln kaufbare
Schiffe gerade doch verfügbar sind (der eigentliche "Sale"-Mechanismus im
Spiel, nicht nur reine Rabatte).

## Wie die Sale-Erkennung funktioniert

RSI hat keine offizielle "ist im Sale"-Markierung. Stattdessen, in
Prioritätsreihenfolge:

1. **Gelisteter Preis-Tier-Rabatt**: manche Schiffe haben mehrere
   "Standalone-Ships"-Angebote gleichzeitig (z.B. ein günstigerer, nicht
   erstattungsfähiger "Warbond"-Preis neben dem Normalpreis). Der höchste
   Tier gilt als Streichpreis (MSRP), der niedrigste als aktueller Preis —
   unabhängig vom Namen der SKU. Kein Backfill nötig, ab dem ersten Scan
   sichtbar.
2. **Fallback Preis-Historie**: wenn RSI selbst keinen zweiten Tier zeigt,
   Referenzpreis = häufigster beobachteter Preis der letzten 30 Tage (den
   aktuellsten Scan ausgenommen). Fällt der aktuelle Preis darunter, gilt es
   als Sale. Braucht Historie — beim allerersten Scan eines neuen Schiffs
   noch nicht erkennbar.
3. **Neu verfügbar**: ein Schiff, das in den letzten 14 Tagen durchgehend
   `OutOfStock` (nicht einzeln kaufbar) war und jetzt `InStock` ist.

## Kalender

Zweiter Tab in der UI, drei Quellen, keine erfundenen Termine:

- **Bekannte wiederkehrende Events** (`events.js`, statisch, von Hand
  gepflegt): Invictus, Alien Week, IAE, Luminalia usw. mit ihrem üblichen
  Monat aus mehreren Jahren Community-Beobachtung — klar als "erwartet"
  markiert, RSI legt den exakten Termin erst kurz vorher fest.
- **Live erkannte Ankündigungen**: der Scanner liest RSIs Comm-Link-
  Newsliste (`/en/comm-link`) inkrementell mit und gleicht Artikeltitel
  gegen bekannte Event-Namen ab (Invictus, IAE, Alien Week, ...). Trifft
  einer, taucht der Artikel mit echtem Link und Titel im Kalender auf —
  das ist der tatsächlich bestätigte Termin, sobald RSI ihn ankündigt.
- **Schiffe in Entwicklung**: RSIs öffentliche Ship-Matrix-API liefert
  einen groben Produktionsstatus (`flight-ready` / `in-concept`) plus
  einen kurzen Freitext-Hinweis, aber **kein Datum** — RSI veröffentlicht
  keine verbindlichen Release-Termine für Schiffe in Entwicklung. Diese
  Liste zeigt entsprechend nur Status + Hinweis, nie ein erfundenes Datum.

## Architektur

- **Preis-Scanner** (`scanner.js: runScan`): holt alle Store-Items über
  RSIs intern genutzte `POST /api/store/getShips` (JSON, paginiert), dann
  pro Schiff Preis + Verfügbarkeit aus dem `schema.org`-JSON-LD der
  jeweiligen Schiffsseite.
- **Comm-Link-Scanner** (`scanner.js: scanCommLink`): liest die
  Newsliste inkrementell (bricht ab, sobald ein bereits bekannter Artikel
  auftaucht), matcht Titel gegen `EVENT_KEYWORDS`.
- **Ship-Matrix-Scanner** (`scanner.js: scanShipsInDevelopment`): einmal
  pro Tag (`SHIP_MATRIX_INTERVAL_HOURS`), da der Datensatz sich selten
  ändert und ~5MB pro Abruf sind.
- Preis- und Comm-Link-Scan laufen alle `SCAN_INTERVAL_MINUTES` (Default
  60 = stündlich) nacheinander (nicht parallel), mit
  `SCAN_REQUEST_DELAY_MS` Pause zwischen jedem einzelnen Request.
- **Speicher**: SQLite (`better-sqlite3`). Kein Postgres nötig für diesen
  Umfang.
- **Frontend**: reines Polling, **keine WebSockets** — fragt `/api/status`
  jede Minute ab und lädt `/api/items` nur neu, wenn sich der Scan-
  Zeitstempel geändert hat. Der Kalender-Tab lädt einmalig beim Öffnen.

## Deployment

Wie die anderen Docker-Projekte: über Portainer auf dem Docker-Host
(`192.168.40.251`), dahinter Nginx Proxy Manager für die öffentliche
Domain.

```bash
cp .env.example .env   # Port/Intervall anpassen falls gewünscht
docker compose up -d --build
```

Erreichbar dann unter `http://<docker-host>:3400` (bzw. der konfigurierte
`HOST_PORT`), bis eine NPM-Domain davorgeschaltet ist.

## Respektvolles Scraping

- Eigener, erklärender `User-Agent`-String.
- Default-Intervall 60 Minuten statt minütlicher Polls.
- Delay zwischen jedem einzelnen Request (Listing-Seiten, Schiffsdetails,
  Comm-Link-Seiten).
- Ship-Matrix (5MB) nur einmal täglich, nicht bei jedem Preis-Scan.
- Kein Login/Session/Cookies nötig, nur öffentlich zugängliche Seiten.
