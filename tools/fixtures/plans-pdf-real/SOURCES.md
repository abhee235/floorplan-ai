# Real PDF plan pages and their licences

Pages from PDFs drawn by other people, used to measure the vector PDF reader on
drawings we did not generate. The reports are tens of megabytes, so each fixture
keeps only one page: its painted line work and text runs, rounded to 0.01 pt by
`tools/build-pdf-real-fixture.ts`. No geometry is changed.

## nist-tn1838-first-floor.page.json

- Drawing: "2315 West 50th Place, 1st Floor", Figure A.1 of Appendix A,
  Dimensioned Drawings. A dimensioned CAD floor plan in metres, with a legend
  for door and window symbols, wall thicknesses noted as 0.17 m outside and
  0.11 or 0.15 m inside, and a stated accuracy of 15 cm.
- Source: NIST Technical Note 1838, "Simulation of an Attic Fire in a Wood
  Frame Residential Structure, Chicago, Illinois", page 48:
  https://nvlpubs.nist.gov/nistpubs/TechnicalNotes/NIST.TN.1838.pdf
- Licence: public domain. A work prepared by employees of the United States
  federal government (Title 17, Chapter 1, Section 105 of the US Code); NIST
  publications carry no copyright in the United States.
- Rebuild it with:
  `corepack pnpm exec tsx tools/build-pdf-real-fixture.ts <NIST.TN.1838.pdf> 48 nist-tn1838-first-floor`
