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

## 3. Afvis ikke-inviterede ved tilmelding (hook)

Funktionen `public.hook_before_user_created` er allerede oprettet af `schema.sql`.

1. **Authentication** > **Hooks** (nogle gange under *Auth Hooks*) > **Before User Created**.
2. Vælg type **Postgres function**, schema `public`, funktion `hook_before_user_created`, og gem/bekræft.

Jeg har ikke kunnet afprøve hooket mod et rigtigt Supabase-projekt, og dashboardets menunavne og hook-formatet (input `event.user.email`, svar `{}` = tillad, `{"error": {...}}` = afvis) kan have ændret sig. Det gør ikke noget for sikkerheden: **den egentlige beskyttelse er Row Level Security**. Står en e-mail ikke i `allowed_emails`, kan personen højst logge ind, men hverken læse eller skrive noget. Virker hooket ikke, så slå det fra og lad RLS gøre arbejdet.

Fjerner du en e-mail fra `allowed_emails`, mister personen straks adgang til sine produkter (de slettes ikke).

## 4. Nøgler

I Supabase: **Project Settings** > **API** (eller *API Keys*). Noter:
- **Project URL** (`https://xxxx.supabase.co`)
- **anon / publishable key** (offentlig; bruges af siden i `web/`)
- **service_role / secret key** (HEMMELIG; bruges kun af prisjobbet. Må aldrig stå i `web/` eller i koden.)

## 5. Resend (e-mails om fald i pris)

1. Opret konto på resend.com. Under **Domains** kan du verificere dit eget domæne og sende fra f.eks. `pris@dit-domæne.dk`. Uden eget domæne kan du til test kun sende fra `onboarding@resend.dev` til din egen adresse.
2. **API Keys** > opret en nøgle med rettigheden *Sending access*.

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

1. Kør hele `supabase/schema.sql` igen i **SQL Editor** (det er sikkert; der oprettes ikke et nyt token, hvis der allerede er et).
2. Nederst i resultatet vises en kolonne `resolver_token_copy_this` med en lang tekst. Kopiér den. Den kan også ses senere ved at køre `select token from public.resolver_secret;` i SQL Editor.
3. Teksten er værdien til hemmeligheden `x-resolver-token`, som navne-assistenten bruger (sendes som HTTP-headeren `x-resolver-token`). Assistenten bruger kun den offentlige anon/publishable-nøgle, aldrig service_role-nøglen. Del ikke tokenet andre steder, og læg det ikke i repoet.
4. Vil du skifte tokenet: `update public.resolver_secret set token = replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');`, og opdatér hemmeligheden hos assistenten.

## To slags links

Man kan indsætte to slags links. Et link fra prisjagt.dk giver priser fra mange butikker, og her vælger man variant. Et link til en enkelt butiks produktside (et hvilket som helst `https://`-link, fx til en vare, som kun den butik sælger) følger kun den ene butik og dens pris; historikken starter den dag, varen bliver tilføjet. Det virker kun, hvis siden selv oplyser pris og lagerstatus i dansk kroner (JSON-LD, `itemprop="price"` eller `product:price:amount`), og hvis butikken ikke afviser automatiske opslag. Afviser den, eller kan prisen ikke findes, får produktet en fejlnote, og jobbet forsøger ikke at omgå det. Kør `supabase/schema.sql` igen, så databasen tillader links til andre butikker.

## Adgangsanmodninger ("bed om adgang")

Kør hele `supabase/schema.sql` igen i **SQL Editor** (det er sikkert og kan gentages), så tabellen `access_requests` og funktionerne bag oprettes.

- Den, der ikke har adgang, kan på login-skærmen trykke "Har du ikke adgang endnu? Bed om adgang" og skrive sin e-mail og sit navn. Prøver nogen at logge ind med en adresse, der ikke er godkendt, får de samme formular med adressen udfyldt. Der kan højst vente 30 anmodninger ad gangen.
- Prisjobbet (hvert 15. minut) sender dig, og alle andre administratorer, én mail med de nye anmodninger. Det kræver **Resend** (`RESEND_API_KEY`, `MAIL_FROM` og `SITE_URL`, trin 5 og 6). Uden Resend sendes ingen mails; anmodningerne ligger stadig i siden.
- Log ind på siden som administrator. Nederst findes afsnittet **Adgang**, og et tal ved siden af navnet viser, hvor mange der venter. Tryk **Godkend** eller **Afvis** (Afvis spørger først). Godkender du, kommer adressen i `allowed_emails`, og personen kan logge ind med det samme.
- Næste gang jobbet kører, får den godkendte en mail: "Du har fået adgang til Prisvagten" med link til siden og en linje om, hvordan man logger ind.
- Under **Hvem har adgang** kan du trykke **Fjern adgang** (med bekræftelse). Administratorer kan ikke fjernes her. Personens produkter bliver liggende. Kommer personen tilbage, skal vedkommende bede om adgang igen.
- Siden kan ikke selv sende mails, så uden Resend skal du selv give besked til dem, du godkender.

## Hverdagen

- Ny person: de kan bede om adgang på siden (se ovenfor), eller du tilføjer e-mailen i `allowed_emails` og sender dem linket.
- Jobbet henter hver produktside højst én gang pr. kørsel, med 1,5 sekunds pause, og forsøger aldrig at omgå en blokering. Svarer Prisjagt med 403/429, springer jobbet resten over i den kørsel, og produktet får en note.
- Et produkt i fejl-tilstand prøves igen efter 6 timer (produkter uden link, altså kun et navn, springes over, til der er et link). Skifter nogen linket, starter produktet forfra.
