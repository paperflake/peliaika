# Vaihtokoppi

Selainpohjainen työkalu junioreiden jalkapallovalmentajalle: hallitsee vaihdot niin,
että kaikki pelaajat saavat suunnilleen yhtä paljon peliaikaa. Ei vaadi asennusta,
palvelinta tai kirjautumista — toimii suoraan selaimessa ja tallentaa tiedot
laitteesi selaimeen (localStorage).

## Käyttöönotto GitHub Pagesiin

1. Luo GitHub-tunnuksellesi uusi repositorio (esim. `vaihtokoppi`).
2. Lisää repoon nämä kolme tiedostoa repon juureen: `index.html`, `style.css`, `app.js`
   (esim. "Add file → Upload files" GitHubin web-käyttöliittymässä, tai `git push`).
3. Mene repon **Settings → Pages**.
4. Kohdassa "Build and deployment": valitse **Deploy from a branch**, branch **main**
   (tai `master`) ja kansio **/ (root)**. Tallenna.
5. Odota pari minuuttia — GitHub näyttää osoitteen muotoa
   `https://KÄYTTÄJÄTUNNUS.github.io/vaihtokoppi/`. Sama osoite toimii sellaisenaan
   myös puhelimen selaimessa kentän laidalla.

Voit halutessasi lisätä osoitteen puhelimen aloitusnäytölle
("Lisää aloitusnäyttöön" / "Add to Home Screen") — se aukeaa silloin kuin sovellus.

## Miten data säilyy

Kaikki tieto (joukkue, ottelut, tilastot) tallentuu selaimen omaan muistiin
(localStorage) sillä laitteella ja selaimessa jota käytät. Tämä tarkoittaa:

- Tieto säilyy sivun päivityksissä ja uudelleenkäynnistyksissä samalla laitteella.
- Tieto **ei** siirry automaattisesti toiselle laitteelle tai toiseen selaimeen.
- Selaimen "tyhjennä selaushistoria/evästeet" voi pyyhkiä tiedot.

Tämän vuoksi Joukkue-välilehdellä on **Vie tiedosto (.json)** -nappi, jolla saat
varmuuskopion ladattua koneelle/puhelimeen, ja **Tuo tiedosto** -nappi tuomaan sen
takaisin (tai siirtämään tiedot toiselle laitteelle). Kannattaa ottaa varmuuskopio
esim. jokaisen turnauspäivän jälkeen.

Huom: jos katsot tiedostoa Claudessa esikatselu-/artifact-näkymän kautta, selaimen
tallennus ei siellä sandboxin takia toimi — kun sivu on julkaistu GitHub Pagesiin ja
avattuna tavallisessa selaimessa, tallennus toimii normaalisti.

## Miten tasapuolisuus lasketaan

Jokaisella kentällä olevalla pelipaikalla (esim. 4 kenttäpelaajaa, asetettavissa)
on joka hetki "reilu osuus" ajasta, joka jaetaan tasan kaikkien sillä hetkellä
mukana olevien kenttäpelaajien kesken (maalivahti pois lukien). Kun joku on
maalivahtina, muiden reilu osuus kasvaa hieman nopeammin sinä aikana, koska
saman verran kenttäaikaa jaetaan pienemmälle joukolle — vaihdon tarve pysyy siis
oikeudenmukaisena vaikka maalivahti vaihtuisi kesken pelin.

Kunkin pelaajan palkki näyttää eron **pelatun ajan** ja tämän **reilun osuuden**
välillä:
- harmaa = ei ole vielä pelannut tässä ottelussa
- vihreä = tasapainossa (asetettavan toleranssin sisällä, oletus ±3 min)
- oranssi = hieman yli toleranssin
- punainen = selvästi yli toleranssin
- sininen = selvästi alle tavoitteen (kannattaa nostaa pian kentälle)

Maalivahdin peliaika **lasketaan mukaan turnauksen kokonaisaikaan** (Tilastot-
välilehti), mutta se ei vaikuta vaihtokiertoon niin kauan kuin pelaaja on
maalivahtina.

## Tekemäni oletukset / rajaukset

Näitä voi pyytää Claudelta muutettavaksi, jos eivät sovi:

- **"4 peliä ottelussa"** tulkittu neljäksi **jaksoksi** yhden ottelun sisällä
  (esim. 4 × 20 min). Jaksojen määrä ja pituus on asetettavissa ottelukohtaisesti;
  tasapuolisuus lasketaan yhtenäisesti koko ottelun (kaikkien jaksojen) yli, ei
  jakso kerrallaan nollautuen.
- Vaihtoasetukset (kenttäpaikkojen määrä, vaihtoryhmän koko, sallittu toleranssi)
  ovat yhteiset koko turnaukselle, eivät ottelukohtaisia.
- Kokoonpanoa (osallistujat, maalivahti, aloittava kenttäkokoonpano) voi muokata
  Ottelut-välilehdeltä vain ennen ottelun alkua. Kesken ottelua maalivahtia vaihdetaan
  Peli-välilehden maalivahtivalitsimesta, ja kenttäkokoonpanoa vaihtopaneelin kautta.
- Vaihtoehdotus laskee aina koko osallistujajoukosta (myös vielä pelaamattomista) —
  jos joku ei syystä tai toisesta voi pelata, jätä hänet pois ottelun osallistujista.

## Tiedostot

- `index.html` — sivun rakenne
- `style.css` — ulkoasu
- `app.js` — kaikki logiikka (ei ulkoisia riippuvuuksia paitsi Google Fonts)
