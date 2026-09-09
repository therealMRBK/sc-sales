// Bekannte, jährlich wiederkehrende Star-Citizen-Events mit ihrem
// üblichen Zeitraum (aus mehreren Jahren Community-Beobachtung, z.B.
// citizenfreefly.com, starcitizentour.com, starcitizen.tools). RSI legt den
// exakten Termin jedes Jahr erst kurz vorher offiziell fest -- das hier ist
// eine Erwartung basierend auf dem historischen Muster, keine Zusage.
// Sobald eine passende Comm-Link-Ankündigung erkannt wird (siehe
// scanner.js/scanCommLink), erscheint der echte Termin separat unter
// "Ankündigungen" mit Link zur Quelle.
//
// month/day sind 1-indiziert. "day" ist optional (nicht jedes Event hat ein
// festes Datum, z.B. Invictus ist "letzte Woche im Mai"). "name" ist bereits
// RSIs offizieller (englischer) Event-Name -- bleibt in beiden Sprachen
// gleich, nur "note"/"noteEn" werden je nach UI-Sprache umgeschaltet.
module.exports = [
  {
    name: "Red Festival",
    month: 1,
    note: "UEE-Feiertag, meist Ende Januar/Anfang Februar. Vor allem kosmetisch (Paints/Deko), kein großer Schiffs-Sale.",
    noteEn: "UEE holiday, usually late January/early February. Mostly cosmetic (paints/decor), no major ship sale.",
    majorSale: false,
  },
  {
    name: "Coramor",
    month: 2,
    day: 11,
    note: "UEE-Feiertag (Valentinstag-Äquivalent). Kosmetische Items, kein großer Schiffs-Sale.",
    noteEn: "UEE holiday (Valentine's Day equivalent). Cosmetic items, no major ship sale.",
    majorSale: false,
  },
  {
    name: "Stella Fortuna",
    month: 3,
    day: 15,
    note: "Glücksspiel-/Casino-Feiertag. Meist kosmetisch, kein großer Schiffs-Sale.",
    noteEn: "Gambling/casino holiday. Mostly cosmetic, no major ship sale.",
    majorSale: false,
  },
  {
    name: "Invictus Launch Week (Fleet Week)",
    month: 5,
    note: "Letzte Maiwoche. UEE-Militärflotte kostenlos flugbar, großer Warbond-Sale auf Militärschiffe.",
    noteEn: "Last week of May. UEE military fleet flyable for free, big Warbond sale on military ships.",
    majorSale: true,
  },
  {
    name: "Alien Week",
    month: 6,
    day: 12,
    note: "Um den 'First Contact Day' (12. Juni). Fokus auf Alien-Hersteller (Banu, Xi'an, Vanduul), inkl. Sale.",
    noteEn: "Around 'First Contact Day' (June 12). Focus on alien manufacturers (Banu, Xi'an, Vanduul), incl. sale.",
    majorSale: true,
  },
  {
    name: "Foundation Festival",
    month: 7,
    note: "Läuft über den ganzen Juli. Baumeister-/Bauthema, meist kosmetisch, gelegentlich kleinere Sales.",
    noteEn: "Runs throughout July. Builder theme, mostly cosmetic, occasionally minor sales.",
    majorSale: false,
  },
  {
    name: "Pirate Week",
    month: 9,
    day: 19,
    note: "Um den 'Talk Like a Pirate Day' (19. September). In-Game-Events (Siege of Orison, Jumptown), inkl. Warbond-Sale.",
    noteEn: "Around 'Talk Like a Pirate Day' (Sept 19). In-game events (Siege of Orison, Jumptown), incl. Warbond sale.",
    majorSale: true,
  },
  {
    name: "CitizenCon",
    month: 10,
    note: "Jährliche Fan-Convention, genauer Termin variiert. Große Reveals/Roadmap-Updates, meist kein klassischer Ship-Sale.",
    noteEn: "Annual fan convention, exact date varies. Major reveals/roadmap updates, usually no classic ship sale.",
    majorSale: false,
  },
  {
    name: "Day of Vara",
    month: 10,
    day: 27,
    note: "UEE-Feiertag. Meist kosmetisch.",
    noteEn: "UEE holiday. Mostly cosmetic.",
    majorSale: false,
  },
  {
    name: "Anniversary / AnniVERSEary Sale",
    month: 11,
    note: "Rund um den Jahrestag der ursprünglichen Kickstarter-Kampagne (Ende Oktober), Termin variiert und überschneidet sich manche Jahre mit der IAE.",
    noteEn: "Around the anniversary of the original Kickstarter campaign (late October), date varies and overlaps with IAE some years.",
    majorSale: true,
  },
  {
    name: "Intergalactic Aerospace Expo (IAE)",
    month: 11,
    note: "Der größte Sale des Jahres, ca. zwei Wochen. Nahezu der komplette Schiffskatalog ist verfügbar, inkl. sonst nicht kaufbarer Konzeptschiffe.",
    noteEn: "The biggest sale of the year, roughly two weeks. Nearly the entire ship catalog is available, incl. otherwise unavailable concept ships.",
    majorSale: true,
  },
  {
    name: "Luminalia",
    month: 12,
    day: 22,
    note: "Winter-/Geschenke-Feiertag. Kleinerer Sale, oft mit Bundle-Angeboten.",
    noteEn: "Winter/gift-giving holiday. Smaller sale, often with bundle deals.",
    majorSale: true,
  },
];
