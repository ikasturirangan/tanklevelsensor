# Terrace Tank — Next.js dashboard and backend

This is the selected implementation: **a standard Next.js app with a small water-level UI and its own API routes**. It replaces the separate Firebase Functions and Cloudflare Worker proposals.

- Host the app and API together on **Vercel Hobby** for this personal project.
- Keep **Firebase Spark** for the **default Firestore database**. Firebase Authentication is used only for the owner to link Google Home; dashboard visitors do not sign in. No Firebase Cloud Functions, named database, or Blaze upgrade is used.
- The ESP32 posts measurements using its device key. Anyone with the dashboard link can view Terrace Tank through its public, read-only API. The same app exposes authenticated Google Home OAuth and fulfillment endpoints.
- The page shows live readings only. Until the backend and sensor are connected, it displays a waiting message and an unknown level.

The public dashboard is deployed at **[terrace-tank.vercel.app](https://terrace-tank.vercel.app)** on the existing Vercel Hobby plan. Anonymous browser checks passed: the dashboard opens without sign-in. Deployment details are recorded in `DEPLOYMENT-STATUS.json`. Live Firebase settings, a provisioned tank and ESP32 HTTPS firmware are still needed for real readings. Google Home account linking is configured separately.

## Try it now

```sh
cd /Users/ikasturirangan/Desktop/globeseeker/terrace-tank-next
npm ci
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). A local development server was started during setup. If it is still running, use that server rather than starting another on port 3000.

The dashboard includes percentage, estimated litres, surface distance, connection status, last-update age, a 24-hour volume graph and seven days of observed water-use/refill totals. It refreshes the latest public reading every 30 seconds and history every 5 minutes without sign-in. Live measurements become unknown after 3 minutes without a new upload.

Open **Tank dimensions & calibration** on the public page to calculate volume from measurements. Saving is an owner operation protected by `TANK_ADMIN_KEY`; ordinary visitors do not sign in. Supported models are an upright round cylinder, a rectangular tank, or a linear estimate based on usable capacity. The 1,000 L model is preselected, but saving remains disabled until measured sensor-to-bottom and sensor-to-full-water distances are entered and checked.

The calculation uses water depth `empty distance − current distance`. For straight-sided tanks, litres come from internal cross-sectional area × depth. The capacity model scales usable capacity by the measured depth fraction; it is approximate for tapered or domed tanks. Capacity must describe the water held at the selected full reference, which may be below the advertised tank capacity.

## Tests

```sh
npm run build
JAVA_HOME=/opt/homebrew/opt/openjdk PATH=/opt/homebrew/opt/openjdk/bin:$PATH npm run test:emulator
```

The emulator command uses the newer Java already installed on this Mac. Other machines need Java 21+ on their PATH. Tests use only project `demo-terrace-tank` and its local default Firestore database; no production data is accessed. `npm test` alone skips the database integration tests unless the emulator is running.

For browser interaction checks, with the dev server running and Google Chrome installed:

```sh
node scripts/check-ui.mjs
```

Validated on 5 September 2026: production build successful; **22 backend and calculation tests passed, none failed or skipped**. Browser checks cover anonymous viewing, litres, calibration, history, empty/full/missing/stale readings, phone width, health API and protected maintenance. Browser tests use controlled readings; backend tests use the local Firestore emulator. Live cloud IAM, Firebase login, Google Home UI/Report State, actual free-hosting CPU/resource usage and ESP32 TLS uploads still require deployment testing.

## How requests flow

```text
ESP32 ── HTTPS POST ──> Next.js /api/v1/devices/terrace-tank/readings
                              │
                              └─> Firestore Spark (default database)

Dashboard ── public GET ──> Next.js /api/v1/tank
Google Home ── OAuth + intents ──> Next.js /api/oauth/* and /api/google/fulfillment
```

Readings are stored in Firestore, not a server variable or a local Vercel file. Serverless instances are temporary. Upload tokens are device-specific and stored as hashes; database rules deny direct client access. The public `/api/v1/tank` endpoint publishes only Terrace Tank’s name, room, level, distance, source, connection status and timestamp. It does not expose owner IDs, upload credentials, other devices or OAuth state. The existing account-scoped `/api/v1/devices` endpoint and all uploads/account-linking routes still require authentication.

## Source code and GitHub

Repository: **[ikasturirangan/tanklevelsensor](https://github.com/ikasturirangan/tanklevelsensor)**. The default branch is `main`, and the repository is connected to the existing Terrace Tank Vercel project.

The Next.js app and backend are in this repository:

- `components/tank-dashboard.jsx`: public tank dashboard.
- `app/globals.css`: page styling.
- `pages/api/[...path].js`: Next.js API entry point.
- `lib/server/`: upload, reading and Google Home backend logic.
- `scripts/`: provisioning and development tools; `test/`: backend tests.

The ESP32 firmware is a separate Arduino project and is not part of this web-app repository. See the hardware project for flashing instructions.

The local source folder is `/Users/ikasturirangan/Desktop/globeseeker/terrace-tank-next`. Git ignores `.env.local`, local credentials, dependencies, build output and Vercel account links. `origin` points to `https://github.com/ikasturirangan/tanklevelsensor.git`. Push changes with `git push origin main`; Vercel deploys updates from this repository.

## Free Firebase setup

Use project **homeintegrations-43740** and remain on **Spark**.

1. Use `.env.example` as the template for `.env.local`. The public dashboard backend needs the server-only `FIREBASE_SERVICE_ACCOUNT_JSON` and the matching project ID. Register a Firebase Web app and copy its API key only when setting up Google Home account linking.
2. For the owner’s Google Home linking and the existing provisioning script, enable Authentication → Email/Password and create the tank owner’s account. Record its Authentication UID. Visitors never need this account. The Google account that owns the project is not automatically a Firebase Auth user.
3. Create the **default** Firestore database in production mode. Choose the region during creation; it cannot be casually changed afterward. Do not create a named `terrace-tank` database: this version intentionally uses the default database eligible for the free quota.
4. Apply `firestore.rules` to that database. The file denies direct reads/writes; the Next.js Admin SDK accesses it through authenticated server routes. This project had no Firestore database when last inspected. If you add unrelated data/apps before setup, merge their rules instead of overwriting them.
5. Create a dedicated service account for this app, with database read/write permission (`roles/datastore.user`) and Firebase Auth user-read permission (`roles/firebaseauth.viewer`). For Google Home reporting, enable HomeGraph API in the same project and follow [Google's service-account instructions](https://developers.home.google.com/cloud-to-cloud/integration/report-state). Save its JSON key privately. Place the complete JSON in the server-only environment variable `FIREBASE_SERVICE_ACCOUNT_JSON`.
6. Generate random secrets of at least 32 characters for `TANK_OAUTH_CLIENT_SECRET` and `CRON_SECRET`. `TANK_OAUTH_CLIENT_ID` can stay `terrace-tank-google-home`. Keep private values out of Git, browser code and chat. A `.env.local` value holding JSON can be single-quoted on one line; in Vercel's environment editor paste the JSON value itself without shell quotes.
7. Generate a separate random `TANK_ADMIN_KEY` of at least 32 characters. Enter this key only when saving tank dimensions. It is not needed to view the public dashboard.

The Firebase API key identifies the Web app used for Google account linking; it is not the device upload credential. The public dashboard does not load Firebase Auth. The service-account project must match `NEXT_PUBLIC_FIREBASE_PROJECT_ID`, and its private JSON must remain server-only.

## Deploy to Vercel Hobby

This directory is linked to the `terrace-tank` project in `kasturirangan-iyengars-projects` on **Hobby**. For a new checkout, sign in and link to that existing project:

```sh
npx vercel login
npx vercel link --project terrace-tank --scope kasturirangan-iyengars-projects
```

The app can be deployed without environment variables and shows a waiting message until live monitoring is configured. Add the service-account JSON for real readings; the Firebase API key and OAuth secret are only needed for Google Home linking. Add `CRON_SECRET` for scheduled maintenance. Select the appropriate Preview/Production environments and redeploy after changing variables.

```sh
npx vercel --prod
```

Use the production HTTPS URL as `APP_URL`; no purchased domain is needed. Google and the ESP32 must be able to reach the API without a Vercel deployment-protection login. The dashboard and its reading endpoint are intentionally public. Keep the ESP32 upload key and Google Home OAuth secrets server-side.

Check `APP_URL/api/health`. It reports `dashboardAccess: "public"`. `liveBackendConfigured` checks for the service-account setting, while `googleHomeConfigured` separately checks the Google linking settings. These flags check configuration presence, not successful Firestore or Google connectivity.

## Provision the tank

Once Firebase Auth and the database are ready, supply the private service-account environment to the provisioning script. Node 22 can load the local env file:

```sh
node --env-file=.env.local scripts/provision.js --uid YOUR_FIREBASE_AUTH_UID --credentials /absolute/private/path/terrace-tank.credentials.json
```

The script verifies the Auth user, creates the tank registry entry, and saves the upload token in a private file with mode 0600. It refuses to overwrite an existing device or credential. The tank is named **Terrace Tank**, room **Attic**. With no calibration arguments it intentionally leaves calibration unconfirmed.

When the sensor arrives, use actual empty/full distances for calibration. Example values of 1500 mm empty and 200 mm full are for simulation only. Percentage measures water height; it equals volume percentage only for a constant horizontal cross-section.

## Upload contract

```http
POST APP_URL/api/v1/devices/terrace-tank/readings
Authorization: Bearer DEVICE_UPLOAD_TOKEN
Content-Type: application/json

{"distanceMm":null,"source":"sensor","bootId":"random-id-for-this-boot","sequence":0}
```

Send null if the sensor has no fresh reading. Otherwise send a filtered integer distance from 30–4500 mm. Use a random boot ID, increment sequence for each new upload, and reuse the exact body for retries. Upload about once/minute; new uploads within 10 seconds receive 429. An accepted reading returns 202; an identical retry returns 200 without making its timestamp fresh. The server derives the percentage from stored calibration.

Each accepted upload also updates one daily history document. Duplicate retries do not add history. Falling calibrated levels count as observed use; rising levels count as water added. Changes smaller than the calibration noise allowance accumulate until significant, while missing readings, simulated data, gaps of three minutes or more and calibration changes start a new baseline. The dashboard shows 24 hours of downsampled volume and seven daily totals in `Asia/Kolkata`. Maintenance removes history older than 90 days.

The node can retrieve its current confirmed calibration with an authenticated `GET /api/v1/devices/terrace-tank/calibration` using the device upload token. The currently flashed firmware does not call this endpoint yet; it still needs the planned HTTPS reporting update. Keeping litre calculations on the backend means tank dimensions can be corrected without reflashing after cloud reporting is installed.

Consumption is estimated from net level changes. It includes any drawdown from taps, leakage or evaporation, and it cannot distinguish water being used while the tank is filling. A flow meter is required when those quantities must be separated.

The ESP32's current flashed firmware still supplies Apple Home through Matter. It needs an HTTPS upload task added, compiled and tested before it can populate this app. Keep certificate/hostname validation enabled, synchronize the clock, and bound network timeouts. No firmware or Apple pairing was changed while building this app.

## Google Home

Create a Cloud-to-cloud integration in [Google Home Developer Console](https://console.home.google.com/) using **homeintegrations-43740**. Use the same project as the Firebase Auth and service-account configuration.

| Setting | Value |
| --- | --- |
| Name | Terrace Tank |
| Flow | OAuth authorization code |
| Client ID | `terrace-tank-google-home` |
| Client secret | `TANK_OAUTH_CLIENT_SECRET` |
| Authorization URL | `APP_URL/api/oauth/authorize` |
| Token URL | `APP_URL/api/oauth/token` |
| Fulfillment URL | `APP_URL/api/google/fulfillment` |
| Scope | `devices` |

Enable testing for your Google account, add the test service in Google Home through Works with Google Home, and sign in with the provisioned Firebase Auth account. The earlier Matter VID/PID registration does not apply to this cloud route. This personal integration is not a certified consumer product.

The backend supports SYNC, QUERY and DISCONNECT; commands are read-only and unsupported actions return `functionNotSupported`. Account unlinking revokes access/refresh tokens and pending authorization codes. Uploads report changed state to Google; failures preserve the reading for retry.

**Google display limitation:** the existing integration represents level as a humidity percentage proxy. Google may label it humidity and include it in climate summaries. Its documented cloud humidity range is integer 1–100%. The app/API show a genuine 0%, but Google reports unavailable for 0%, missing, stale, simulated or uncalibrated data. Simulation is restricted to the protected developer upload tool; it is not available on the public page.

## Offline checks on free hosting

The dashboard detects stale data itself, and Google QUERY always checks freshness. An upload updates Google's cached state immediately when possible. If the ESP32 stops uploading while the dashboard is closed, Google also needs a periodic check to update its cache.

`/api/maintenance` performs that check and cleans up expired OAuth records. It requires `Authorization: Bearer CRON_SECRET` and accepts GET or POST. Vercel Hobby only supports daily built-in cron jobs, so `vercel.json` schedules daily cleanup. For prompt Google offline updates, configure a **free external scheduler** to call the same protected endpoint about once/minute. This does not require a separate backend. Until that scheduler is configured, Google's cached status may lag despite the Next.js API and dashboard correctly showing stale data.

## Free-plan boundaries

Vercel Hobby is for personal, non-commercial use. Firebase Spark's default Firestore database includes 20,000 document writes and 50,000 reads/day; one upload/minute and normal dashboard use fit comfortably within those quotas for one tank. Runtime/auth/egress limits still apply. Staying on these free plans does not provide unlimited usage or a service guarantee. No paid plan was enabled.

Sources: [Vercel Hobby](https://vercel.com/docs/plans/hobby), [Vercel cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing), [Firebase Spark pricing](https://firebase.google.com/pricing), [Firestore free quota](https://firebase.google.com/docs/firestore/quotas), [Google humidity schema](https://developers.home.google.com/cloud-to-cloud/traits/humiditysetting).
