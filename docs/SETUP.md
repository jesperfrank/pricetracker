# Opsætning af Prisvagten

Du skal bruge: en GitHub-konto med repoet, en gratis Supabase-konto og en gratis Resend-konto. Tag det i denne rækkefølge.

## 1. Supabase-projekt

1. Opret et projekt på supabase.com (region EU, f.eks. Frankfurt). Gem database-adgangskoden.
2. Åbn **SQL Editor** > **New query**, indsæt hele indholdet af `supabase/schema.sql` og tryk **Run**. Filen kan køres igen uden skade.
3. Åbn **Table Editor** > `allowed_emails` og tilføj en række pr. person, der må bruge siden: `email` med **små bogstaver**, evt. en `note`. Husk din egen adresse. (Kun du kan se og redigere tabellen; almindelige brugere har ingen adgang.) Du behøver ikke tilføje alle i hånden: andre kan bede om adgang på siden, se "Adgangsanmodninger" nedenfor.
4. Din egen række bliver automatisk administrator (`is_admin`): kør `schema.sql` igen, efter du har tilføjet dig selv (ved en ny database er tabellen tom første gang). Filen gør rækken med den tidligste `added_at` til administrator, hvis ingen er det endnu. Kør filen igen, når du får en opdatering: den ændrer ikke på, hvem der er administrator. Vil du have en ekstra administrator, så sæt `is_admin` til `true` på den række i Table Editor.

## 2. Log ind med e-mail (magic link)

1. **Authentication** > **Providers** > **Email**: slå *Enable Email provider* til. Slå *Confirm email* til, og lad *Magic link* være slået til. (Adgangskode-login bruges ikke.)
2. **Authentication** > **URL Configuration**:
   - *Site URL*: adressen på din GitHub Pages-side, f.eks. `https://DITBRUGERNAVN.github.io/prisvagten/`
   - *Redirect URLs*: tilføj den samme adresse (med `/*` til sidst, hvis Supabase kræver det).
3. Sæt **Authentication** > **Sign In / Providers** (eller *Settings*) så *Allow new users to sign up* er slået **til** (de inviterede skal kunne oprette sig første gang; hooket i trin 3 afviser alle andre).
4. Supabases indbyggede mailserver må kun sende få mails i timen. Til 10-20 personer er det normalt nok, men vil du være sikker, så tilføj Resend som egen SMTP under **Authentication** > **SMTP Settings** (host `smtp.resend.com`, port `465`, bruger `resend`, adgangskode = din Resend API-nøgle, afsender = din verificerede adresse).

### Kode i mailen (til appen på hjemmeskærmen)

På iPhone har en app på hjemmeskærmen sit eget lager, adskilt fra Safari. Linket i mailen åbner i Safari, så personen bliver logget ind dér, men ikke i appen. Derfor kan man også skrive koden fra mailen på siden. Det kræver, at mailen indeholder koden:

1. **Authentication** > **Emails** (nogle gange **Email Templates**) > skabelonen **Magic Link**.
2. Sæt emnet og indholdet til nedenstående. Linjen med `{{ .Token }}` er den vigtige: den sætter koden ind. Linket `{{ .ConfirmationURL }}` skal blive, så det virker som før i en almindelig browser.
3. Brug **samme tekst i skabelonen "Confirm signup"**. Første gang en ny person logger ind, sender Supabase nemlig den skabelon i stedet for "Magic Link".

Emne:

```
Dit login til Prisvagten
```

Indhold (HTML):

```html
<h2>Log ind på Prisvagten</h2>
<p><a href="{{ .ConfirmationURL }}">Åbn linket for at logge ind</a></p>
<p>Eller skriv denne kode på siden:</p>
<p style="font-size:24px;font-weight:bold;letter-spacing:4px">{{ .Token }}</p>
<p>Koden og linket virker kun en kort tid. Har du ikke bedt om login, kan du se bort fra mailen.</p>
```

Siden accepterer en kode på 6 til 8 cifre, så den passer, uanset hvor lang en kode projektet er sat til at bruge (**Authentication** > **Sign In / Providers** > **Email** > *Email OTP Length*).

Jeg er usikker på de præcise navne i dashboardet: i nogle versioner hedder menuen **Authentication** > **Email Templates**, i andre ligger skabelonerne under **Authentication** > **Emails** > **Templates**, og skabelonerne hedder "Magic Link" og "Confirm signup" (i nye versioner kan "Confirm signup" hedde "Confirm sign up"). Jeg har ikke afprøvet det mod et rigtigt projekt. Mangler koden i mailen, er det skabelonen, der ikke er ændret.

## 3. Afvis ikke-inviterede ved tilmelding (hook, valgfri)

**Hvad det gør.** Hooket "Before User Created" kører, lige før Supabase opretter en ny konto ved første login. Står adressen ikke i `allowed_emails`, afvises den, og der oprettes ingen konto og sendes ingen mail. Funktionen `public.hook_before_user_created` er allerede oprettet af `schema.sql`. Den svarer med fejlen "Denne e-mailadresse er ikke inviteret."

**Siden er sikker uden hooket.** Databasereglerne (Row Level Security) lader kun adresser i `allowed_emails` læse eller skrive noget. En person uden adgang kan uden hooket højst logge ind og lande på skærmen "Du har ikke adgang endnu", hvor vedkommende kan bede om adgang. Hooket er kun en ekstra lås, der holder fremmede helt ude af brugerlisten.

**Sådan slår du det til** (fra min viden om dashboardet, ikke afprøvet):

1. Åbn Supabase-projektet > **Authentication** > **Hooks** (i nogle versioner **Auth Hooks**).
2. Vælg **Before User Created**, og tryk på knappen til at tilføje/oprette hook.
3. Vælg type **Postgres function**, schema `public`, funktion `hook_before_user_created`.
4. Slå hooket til (*Enable*), og tryk **Create** eller **Save**.

Jeg er usikker på de præcise knap- og menunavne i det nuværende dashboard (på nogle planer og versioner ligger hooks et andet sted, eller kræver at man først vælger *Postgres* som type). Jeg har ikke kunnet afprøve hooket mod et rigtigt projekt. Finder du det ikke, så spring trinnet over: siden virker fuldt ud uden.

**Det skal du vide, når hooket er slået til:**

- En person, der endnu ikke er godkendt, kan slet ikke logge ind første gang. Skærmen "Du har ikke adgang endnu" ses derfor aldrig for nye adresser. Den eneste vej er "Ingen adgang endnu? Bed om adgang" på login-skærmen. Skriver personen sin adresse i login-feltet, afvises den af hooket, og siden viser "Adressen har ikke adgang endnu. Bed om adgang herunder, så får ejeren besked." med anmodningsformularen åben og adressen udfyldt. Siden genkender afvisningen på teksten "ikke inviteret" eller på en afvisning/hook-fejl fra login (status 403 eller 422). Er fejlens ordlyd en anden i dit projekt, ser personen i stedet en generel fejl, og formularen åbner ikke af sig selv; linket "Bed om adgang" virker stadig.
- Efter godkendelse kan personen logge ind som normalt, fordi adressen nu står i `allowed_emails`.
- Hooket gælder kun oprettelse af nye konti. Har en adresse allerede en konto (fordi den loggede ind, før hooket blev slået til, eller før adgangen blev fjernet), rammes den ikke af hooket og lander på skærmen "Du har ikke adgang endnu" i stedet.
- Slår du hooket fra igen, virker alt som før.

Fjerner du en e-mail fra `allowed_emails`, mister personen straks adgang til sine produkter (de slettes ikke).

## 4. Nøgler

I Supabase: **Project Settings** > **API** (eller *API Keys*). Noter:
- **Project URL** (`https://xxxx.supabase.co`)
- **anon / publishable key** (offentlig; bruges af siden i `web/`)
- **service_role / secret key** (HEMMELIG; bruges kun af prisjobbet. Må aldrig stå i `web/` eller i koden.)

## 5. Resend (e-mails om fald i pris)

1. Opret konto på resend.com. Under **Domains** kan du verificere dit eget domæne og sende fra f.eks. `pris@dit-domæne.dk`. Uden eget domæne kan du til test kun sende fra `onboarding@resend.dev` til din egen adresse.
2. **API Keys** > opret en nøgle med rettigheden *Sending access*.

**Hvem får mail.** Mail er til-valg: ingen får prismails, før de selv siger ja. Første gang en ny person åbner siden, står der en lille linje øverst: "Vil du have mail ved nye tilbud?" med "Ja tak" og "Nej tak". Svaret gemmes, og linjen kommer ikke igen. Under Indstillinger findes to valg: **Mail ved nyt tilbud** (en mail, når et produkt første gang rammer målet, eller når prisen falder yderligere; samme tilbud mailes ikke igen, før der er gået 7 dage, medmindre man ændrer mål eller link) og **Daglig oversigt om morgenen** (slået fra som standard; én mail om dagen ved første kørsel efter kl. 7 dansk tid med det, der er på tilbud nu, og de produkter, hvis laveste pris har ændret sig mindst 5 % siden i går; ingen mail, hvis der intet er at sige). Den daglige oversigt kræver, at "Mail ved nyt tilbud" er slået til, og forsinker aldrig tilbudsmailen. En butik, der af og til afviser os, beholder sit seneste tilbud i op til 24 timer, så prisen ikke hopper frem og tilbage. Mail om adgang (til dig og til nygodkendte) er ikke prismails og sendes uanset valgene. Felterne `products.digest_price` og `products.digest_at` bruges ikke længere og er blot ladt stå.

## 6. GitHub: hemmeligheder og tidsplan

1. Repoet > **Settings** > **Secrets and variables** > **Actions** > **New repository secret**. Opret disse fem:

| Navn | Værdi |
|---|---|
| `SUPABASE_URL` | Project URL fra trin 4 |
| `SUPABASE_SERVICE_KEY` | service_role-nøglen fra trin 4 |
| `RESEND_API_KEY` | nøglen fra trin 5 (kan udelades; så sendes ingen e-mails) |
| `MAIL_FROM` | f.eks. `Prisvagten <pris@dit-domæne.dk>` |
| `SITE_URL` | adressen på siden, f.eks. `https://DITBRUGERNAVN.github.io/prisvagten/` |

2. **Actions**-fanen > **Priser** > **Run workflow** for at prøve det af. Se loggen: den slutter med fem linjer (produkter, sider hentet, hits, e-mails, skrevet).
3. Jobbet kører derefter automatisk hvert 15. minut. GitHub kan forsinke planlagte kørsler lidt, og GitHub slår planlagte workflows fra i et offentligt repo, hvis der ikke har været aktivitet i 60 dage. Dukker priserne ikke længere op, så tryk *Enable workflow* under Actions.

## 7. Siden (GitHub Pages)

Frontenden ligger i `web/` og udgives af workflowet `pages.yml`. Slå Pages til: repoet > **Settings** > **Pages** > *Source*: **GitHub Actions**. Frontenden skal have Project URL og anon-nøglen fra trin 4 (se `web/`).

## Tilføj produkter ved navn (assistenten)

Man kan skrive et produktnavn i stedet for et link. Produktet står så som "Finder produktet …", indtil et link er fundet: enten af brugeren selv ("Søg på Prisjagt" og indsæt linket) eller af navne-assistenten, en separat AI-agent der ikke hører til dette repo.

Er navnet ikke præcist, kan assistenten foreslå 2 til 4 varer ("Mente du"), og man vælger selv; assistentens prompt skal kende `resolver_suggest` (se `docs/AI.md`).

1. Kør hele `supabase/schema.sql` igen i **SQL Editor** (det er sikkert; der oprettes ikke et nyt token, hvis der allerede er et).
2. Nederst i resultatet vises en kolonne `resolver_token_copy_this` med en lang tekst. Kopiér den. Den kan også ses senere ved at køre `select token from public.resolver_secret;` i SQL Editor.
3. Teksten er værdien til hemmeligheden `x-resolver-token`, som navne-assistenten bruger (sendes som HTTP-headeren `x-resolver-token`). Assistenten bruger kun den offentlige anon/publishable-nøgle, aldrig service_role-nøglen. Del ikke tokenet andre steder, og læg det ikke i repoet.
4. Vil du skifte tokenet: `update public.resolver_secret set token = replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');`, og opdatér hemmeligheden hos assistenten.

## Alternativer

Under et produkt kan man trykke "Find alternativer". Navne-assistenten (samme AI-agent og samme `x-resolver-token`, se ovenfor) svarer inden for en time med lignende produkter og gode tilbud i samme kategori. Kør `supabase/schema.sql` igen, så databasen får de nye felter og funktioner; indtil da er knappen skjult. Hver person kan bede om alternativer 5 gange i døgnet. Assistentens tre funktioner og reglerne for dem står i `docs/AI.md`.

## Spørg om en vare

Under feltet til nye varer står "Spørg om en vare": man skriver med egne ord, hvad man leder efter, og navne-assistenten (samme AI-agent og samme `x-resolver-token`) svarer inden for en time med en kort anbefaling og et par konkrete produkter, som man kan følge med et tryk. Kør `supabase/schema.sql` igen, så databasen får tabellen `questions` og funktionerne `ai_ask_*`; indtil da er knappen skjult. Hver person kan stille 5 spørgsmål i døgnet, have 3 i gang og gemme 30. Reglerne for assistenten står i `docs/AI.md`. Husk at opdatere assistentens prompt, så den også henter spørgsmål med `ai_ask_list`.

## Find den billigste butik

Et produkt, der følger én butik (fx fra en ønskeliste på Ønskeskyen), kan skiftes til Prisjagt, så den billigste butik vinder. Det sker af sig selv for alle varer, der følger én butik: jobbet beder navne-assistenten kigge efter dem, højst 10 nye varer pr. kørsel, og en vare, hvor assistenten svarede "ikke fundet", får ét ekstra forsøg efter mindst en time (og en vare med fejl, hvor butikken afviser os, op til et par gange mere efter et døgn). Højst 3 automatiske forsøg pr. vare og link; man kan selv trykke "Find flere butikker" under varen. Navne-assistenten (samme AI-agent og samme `x-resolver-token`) leder efter varen på Prisjagt og skifter kun, når det tydeligt er den samme vare; ellers bliver varen ved med at følge butikken. Et skift kan fortrydes under varen ("Fortryd"). Kør `supabase/schema.sql` igen, så databasen får de nye felter og funktionen `resolver_compare`. Bemærk: `resolver_list` har nu en ekstra kolonne `kind`, så assistentens prompt skal opdateres (se `docs/AI.md`).

### Flere butikker uden Prisjagt

Mange varer (modelbyggersæt, tøj, mindre mærker) er ikke på Prisjagt, men sælges af flere danske butikker. Navne-assistenten kan svare på en sammenligning med op til 5 links til andre butikker (`resolver_compare` med `p_shops`, se `docs/AI.md`). Varen beholder sit eget link, og jobbet henter de andre sider med de samme høflige regler som ellers: højst 30 ekstra sider pr. kørsel, en butik der afviser os springes over resten af kørslen, og et link der fejler 10 gange i træk prøves kun én gang i døgnet. En side, der tydeligt er en anden vare (prisen er under 40 % eller over 250 % af de andre butikkers midterpris), bruges ikke. Alle butikker vises under "Butikker", og under "Indstil vare" kan man fjerne en butik, der ikke passer. Første tjek efter nye butikker sender ingen mail. Kør `supabase/schema.sql` igen, så databasen får felterne `extra_urls` og `extra_state` og den nye udgave af `resolver_compare`. Assistentens prompt skal opdateres (se `docs/AI.md`).

### Detaljer

Under et produkt kan man skrive "Detaljer" (fx farve eller størrelse: "hvid/grøn, str. 43"), også når man tilføjer varen. Det er kun et ønske, ikke et krav, og det gemmes som fri tekst (højst 120 tegn). Navne-assistenten bruger det, når den leder efter varen på Prisjagt eller i andre butikker, og når den vælger varianter ("Finder den rigtige variant"); man kan altid selv vælge. Ændrer man detaljerne, leder assistenten igen. Ønskeskyen-ønsker får deres egen tekst med som detaljer. Kør `supabase/schema.sql` igen, så databasen får felterne `requirements` og `req_state` og funktionen `resolver_variants`; `resolver_list` har to nye kolonner (`req`, `variants`) og en ny slags rækker (`variant`), så assistentens prompt skal opdateres (se `docs/AI.md`).

## To slags links

Man kan indsætte to slags links. Et link fra prisjagt.dk giver priser fra mange butikker, og her vælger man variant. Et link til en enkelt butiks produktside (et hvilket som helst `https://`-link, fx til en vare, som kun den butik sælger) følger kun den ene butik og dens pris; historikken starter den dag, varen bliver tilføjet. Det virker kun, hvis siden selv oplyser pris og lagerstatus i dansk kroner (JSON-LD, `itemprop="price"` eller `product:price:amount`), og hvis butikken ikke afviser automatiske opslag. Afviser den, eller kan prisen ikke findes, får produktet en fejlnote, og jobbet forsøger ikke at omgå det. Kør `supabase/schema.sql` igen, så databasen tillader links til andre butikker.

## Adgangsanmodninger ("bed om adgang")

Kør hele `supabase/schema.sql` igen i **SQL Editor** (det er sikkert og kan gentages), så tabellen `access_requests` og funktionerne bag oprettes.

- Den, der ikke har adgang, kan på login-skærmen trykke "Har du ikke adgang endnu? Bed om adgang" og skrive sin e-mail og sit navn. Logger en person ind med en adresse, der ikke er godkendt, havner vedkommende på skærmen "Du har ikke adgang endnu" med en knap til at bede om adgang (anmodningen vises hos dig på samme måde). Afviser hooket i trin 3 adressen, får personen i stedet den samme formular på login-skærmen med adressen udfyldt. Der kan højst vente 30 anmodninger ad gangen.
- Prisjobbet (hvert 15. minut) sender dig, og alle andre administratorer, én mail med de nye anmodninger. Det kræver **Resend** (`RESEND_API_KEY`, `MAIL_FROM` og `SITE_URL`, trin 5 og 6). Uden Resend sendes ingen mails; anmodningerne ligger stadig i siden. Jobbets log slutter med fx "Adgang: 0 til ejer, 0 godkendte, 2 venter, 1 administrator." (kun tal). Står der 0 administratorer, logger jobbet "Ingen administrator i allowed_emails.", og ingen får besked om nye anmodninger.
- Log ind på siden som administrator. Nederst findes afsnittet **Adgang**, og et tal ved siden af navnet viser, hvor mange der venter. Tryk **Godkend** eller **Afvis** (Afvis spørger først). Godkender du, kommer adressen i `allowed_emails`, og personen kan logge ind med det samme.
- Næste gang jobbet kører, får den godkendte en mail: "Du har fået adgang til Prisvagten" med link til siden og en linje om, hvordan man logger ind.
- Under **Hvem har adgang** kan du trykke **Fjern adgang** (med bekræftelse). Administratorer kan ikke fjernes her. Personens produkter bliver liggende. Kommer personen tilbage, skal vedkommende bede om adgang igen.
- Siden kan ikke selv sende mails, så uden Resend skal du selv give besked til dem, du godkender.

## Lister

Kør hele `supabase/schema.sql` igen i **SQL Editor** (det er sikkert og kan gentages), så tabellen `lists` og kolonnen `products.list_id` oprettes. Indtil da vises listerne ikke på siden, og alt andet virker som før. Derefter kan hver person lave op til 30 egne lister (fx "Elektronik" eller "Bastian") med knappen "+ Ny liste" over produkterne og flytte et produkt til en liste i dets egen visning. Sletter man en liste, bliver produkterne liggende og kommer under "Uden liste". Jobbet og mailene er uændrede.

## Del en liste

Alt er privat for hver person, undtagen en liste, som ejeren selv deler. Vælg listen, tryk **Del**, og skriv e-mailen på en person, der allerede har adgang til Prisvagten og har logget ind mindst én gang (højst 10 personer pr. liste). Er adressen ukendt eller ikke godkendt, svarer siden det samme, så ingen kan finde ud af, hvem der har en konto. Den, der deler med, kan se listen og dens produkter og priser, tilføje produkter og markere et produkt som købt (og fortryde det, hvis vedkommende selv har markeret det). Ejeren af produktet kan altid rette og slette det; ejeren af listen kan fortryde et købt-mærke og fjerne personer. Ingen andre end ejeren kan omdøbe eller slette listen, og ingen kan rette eller slette en andens produkter. Ejeren trykker **Fjern** ved en person, og personen kan selv trykke **Forlad liste**: de produkter, personen selv har tilføjet, bliver hos personen uden liste. Slettes listen, sker det samme for alle. Prismails går fortsat kun til den, der har tilføjet produktet, og 40-grænsen gælder pr. person. Ønskelister fra Ønskeskyen kan kun ejeren af listen følge. Kør hele `supabase/schema.sql` igen, så deling oprettes; indtil da vises ingen deling, og alt andet virker som før.

## Ønskelister fra Ønskeskyen

Indsætter man et delt link fra Ønskeskyen (`onskeskyen.dk/s/…`, eller `gowish.com`) i feltet øverst, henter jobbet ønskerne og tilføjer dem som produkter inden for et kvarter, på den valgte liste, eller på en ny liste med ønskelistens navn. Det virker kun for offentligt delte ønskelister. Det er uofficielt: jobbet bruger de samme offentlige data, som Ønskeskyens egen side henter, så det kan holde op med at virke, hvis Ønskeskyen ændrer sin side. Svarer Ønskeskyen med en blokering eller en fejl, får importen en note, og jobbet forsøger ikke at omgå det. Kør hele `supabase/schema.sql` igen i **SQL Editor**, så tabellen `imports` oprettes; indtil da kan man ikke importere, og alt andet virker som før.

## Hverdagen

- Ny person: de kan bede om adgang på siden (se ovenfor), eller du tilføjer e-mailen i `allowed_emails` og sender dem linket.
- Jobbet henter hver produktside højst én gang pr. kørsel, med 1,5 sekunds pause, og forsøger aldrig at omgå en blokering. Svarer Prisjagt med 403/429, springer jobbet resten over i den kørsel, og produktet får en note.
- Et produkt i fejl-tilstand prøves igen efter 6 timer (produkter uden link, altså kun et navn, springes over, til der er et link). Skifter nogen linket, starter produktet forfra.
