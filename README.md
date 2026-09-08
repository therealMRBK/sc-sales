# sc-sales

Scannt periodisch den [Roberts Space Industries Pledge-Store](https://robertsspaceindustries.com/pledge/ships)
(Star Citizen) und hebt hervor, welche Schiffe im Sale sind — also
entweder im Preis gefallen sind oder normalerweise nicht einzeln kaufbare
Schiffe gerade doch verfügbar sind (der eigentliche "Sale"-Mechanismus im
Spiel, nicht nur reine Rabatte).

## Wie die Erkennung funktioniert

RSI hat keine offizielle "ist im Sale"-Markierung. Stattdessen:

1. **Preis-Sale**: Referenzpreis pro Schiff ist der häufigste beobachtete
   Preis der letzten 30 Tage (den aktuellsten Scan ausgenommen). Fällt der
   aktuelle Preis darunter, gilt es als Sale.
2. **Neu verfügbar**: ein Schiff, das in den letzten 14 Tagen durchgehend
   `OutOfStock` (nicht einzeln kaufbar) war und jetzt `InStock` ist.

Beides braucht Historie — beim allerersten Scan eines neuen Schiffs kann
noch nichts als Sale erkannt werden, das baut sich über Zeit auf.

## Architektur

- **Scanner** (`scanner.js`): holt alle Store-Items über RSIs intern
  genutzte `POST /api/store/getShips` (JSON, paginiert), dann pro Schiff
  Preis + Verfügbarkeit aus dem `schema.org`-JSON-LD der jeweiligen
  Schiffsseite. Läuft alle `SCAN_INTERVAL_MINUTES` (Default 180 = 3h) mit
  `SCAN_REQUEST_DELAY_MS` Pause zwischen Requests.
- **Speicher**: SQLite (`better-sqlite3`), ein Snapshot pro Item pro Scan.
  Kein Postgres nötig für diesen Umfang.
- **Frontend**: reines Polling, **keine WebSockets** — fragt `/api/status`
  jede Minute ab und lädt `/api/items` nur neu, wenn sich der Scan-
  Zeitstempel geändert hat.

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
- Default-Intervall 3h statt minütlicher Polls — Sales ändern sich nicht
  schneller.
- Delay zwischen jedem einzelnen Request (Listing-Seiten + Schiffsdetails).
- Kein Login/Session/Cookies nötig, nur öffentlich zugängliche Store-Seiten.
