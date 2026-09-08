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
// festes Datum, z.B. Invictus ist "letzte Woche im Mai").
module.exports = [
  {
    name: "Red Festival",
    month: 1,
    note: "UEE-Feiertag, meist Ende Januar/Anfang Februar. Vor allem kosmetisch (Paints/Deko), kein großer Schiffs-Sale.",
    majorSale: false,
  },
  {
    name: "Coramor",
    month: 2,
    day: 11,
    note: "UEE-Feiertag (Valentinstag-Äquivalent). Kosmetische Items, kein großer Schiffs-Sale.",
    majorSale: false,
  },
  {
    name: "Stella Fortuna",
    month: 3,
    day: 15,
    note: "Glücksspiel-/Casino-Feiertag. Meist kosmetisch, kein großer Schiffs-Sale.",
    majorSale: false,
  },
  {
    name: "Invictus Launch Week (Fleet Week)",
    month: 5,
    note: "Letzte Maiwoche. UEE-Militärflotte kostenlos flugbar, großer Warbond-Sale auf Militärschiffe.",
    majorSale: true,
  },
  {
    name: "Alien Week",
    month: 6,
    day: 12,
    note: "Um den 'First Contact Day' (12. Juni). Fokus auf Alien-Hersteller (Banu, Xi'an, Vanduul), inkl. Sale.",
    majorSale: true,
  },
  {
    name: "Foundation Festival",
    month: 7,
    note: "Läuft über den ganzen Juli. Baumeister-/Bauthema, meist kosmetisch, gelegentlich kleinere Sales.",
    majorSale: false,
  },
  {
    name: "Pirate Week",
    month: 9,
    day: 19,
    note: "Um den 'Talk Like a Pirate Day' (19. September). In-Game-Events (Siege of Orison, Jumptown), inkl. Warbond-Sale.",
    majorSale: true,
  },
  {
    name: "CitizenCon",
    month: 10,
    note: "Jährliche Fan-Convention, genauer Termin variiert. Große Reveals/Roadmap-Updates, meist kein klassischer Ship-Sale.",
    majorSale: false,
  },
  {
    name: "Day of Vara",
    month: 10,
    day: 27,
    note: "UEE-Feiertag. Meist kosmetisch.",
    majorSale: false,
  },
  {
    name: "Anniversary / AnniVERSEary Sale",
    month: 11,
    note: "Rund um den Jahrestag der ursprünglichen Kickstarter-Kampagne (Ende Oktober), Termin variiert und überschneidet sich manche Jahre mit der IAE.",
    majorSale: true,
  },
  {
    name: "Intergalactic Aerospace Expo (IAE)",
    month: 11,
    note: "Der größte Sale des Jahres, ca. zwei Wochen. Nahezu der komplette Schiffskatalog ist verfügbar, inkl. sonst nicht kaufbarer Konzeptschiffe.",
    majorSale: true,
  },
  {
    name: "Luminalia",
    month: 12,
    day: 22,
    note: "Winter-/Geschenke-Feiertag. Kleinerer Sale, oft mit Bundle-Angeboten.",
    majorSale: true,
  },
];
