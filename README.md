# <img src="https://cdn.jsdelivr.net/gh/iobroker-community-adapters/ioBroker.homeconnect@master/admin/homeconnect.svg" width="48" align="top" /> ioBroker.homeconnect

**Release:** [![npm version](https://img.shields.io/npm/v/iobroker.homeconnect)](https://www.npmjs.com/package/iobroker.homeconnect) ![stable](https://iobroker.live/badges/homeconnect-stable.svg) ![Installations](https://iobroker.live/badges/homeconnect-installed.svg) [![npm downloads](https://img.shields.io/npm/dt/iobroker.homeconnect)](https://www.npmjs.com/package/iobroker.homeconnect)

**Build:** [![Test and Release](https://github.com/iobroker-community-adapters/ioBroker.homeconnect/actions/workflows/test-and-release.yml/badge.svg)](https://github.com/iobroker-community-adapters/ioBroker.homeconnect/actions/workflows/test-and-release.yml) ![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen) ![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue) [![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

**Support:** [![Ko-fi](https://img.shields.io/badge/Ko--fi-Support-ff5e5b?logo=ko-fi)](https://ko-fi.com/krobipd) [![PayPal](https://img.shields.io/badge/Donate-PayPal-blue.svg)](https://paypal.me/krobipd)

Control and monitor your Bosch, Siemens, NEFF and Gaggenau home appliances through the official [Home Connect](https://www.home-connect.com/) cloud API — dishwashers, washers, dryers, ovens, fridges, coffee makers and more. Every value comes through in a form you can use directly, updates live, and programs can be selected, configured and started from ioBroker.

---

## Features

- **All appliance data** — status, settings, events, the active and selected program, and program options.
- **A complete tree** — every data point is created upfront and stays while the appliance is switched off.
- **Live updates** through the Home Connect event stream — changes on the appliance show up within seconds.
- **Full control** — switch settings, select a program, set its options, and start, stop, pause or resume it.
- **Readable values** — on/off as switches, fixed choices as names in your ioBroker language, measurements as numbers with their unit.
- **Encrypted login** — the Client Secret and the login are stored encrypted, the login is refreshed automatically; you sign in once.

## Requirements

- Node.js >= 22
- js-controller >= 7.2.2
- Admin >= 8.0.14
- A free Home Connect developer account (for a Client ID and Client Secret)

> The adapter CANNOT be installed via GitHub: The adapter must be installed via the ioBroker repository (stable or latest).

## Configuration

The adapter signs in with an application of your own in the free Home Connect Developer Program, linked to the Home Connect account of your app.

1. Create a free developer account at [developer.home-connect.com](https://developer.home-connect.com/user/register). As **Default Home Connect Account for Testing** enter the e-mail address of your Home Connect app account — exactly as in the app, in **lower case**. This links the two accounts.
2. [Register an application](https://developer.home-connect.com/applications/add):
   - **Application ID:** any name, e.g. `ioBroker`
   - **OAuth Flow:** `Device Flow` — it cannot be changed later; an application with another flow has to be registered anew
   - **Success Redirect:** leave empty
   - **One Time Token Mode:** off
3. **Wait 15 to 60 minutes.** A new or edited application only becomes active at Home Connect after that — a sign-in before then is refused.
4. Copy the **Client ID** (64 characters) and the **Client Secret** into the adapter settings and save.
5. A **sign-in link** appears in the settings, together with the code it carries. Open it, sign in with your Home Connect account and confirm the code — the panel switches to **signed in** once it is done.
6. **Test connection** in the same panel makes a real request to Home Connect and shows how many appliances are listed and connected, or why it failed.

The login is kept across adapter and version updates, so you sign in once. **Reset sign-in** in the panel forgets it and starts a new sign-in — for example to switch to another Home Connect account.

A sign-in link is renewed every five minutes while it waits. If nobody confirms one for an hour, the adapter stops asking Home Connect for new ones; **Request a new sign-in link** in the panel starts again (so does a restart).

### When the sign-in is refused

The panel shows what Home Connect answered and what to do about it; `auth.lastError` carries Home Connect's own words.

| Home Connect answers | What it means | What to do |
|---|---|---|
| `unauthorized_client: Invalid client id` | The Client ID is unknown | Copy it again from your application (64 characters) |
| `unauthorized_client: request rejected by client authorization authority (developer portal)` | The application is not active (yet) | Wait 15 to 60 minutes after registering or editing it; check that its status is **Enabled**; then request a new sign-in link |
| `unauthorized_client: client not authorized for this oauth flow (grant_type)` | The application uses another OAuth flow | Register a new application with **Device Flow** |
| `invalid_client` | The Client Secret was rejected | Check the Client Secret |
| `access_denied` | The account was refused | Check that the account works in the Home Connect app (SingleKey ID, accepted terms of use) and that it is the one entered in the developer portal |

After moving to a new ioBroker system the stored login cannot be read — sign in once more. Home Connect in China (`api.home-connect.cn`) is not supported.

## Updating from 1.x

Version 2.0 is a new object tree: every appliance gets a readable device folder instead of the raw Home Connect tree of 1.6.x. Your sign-in and Client ID are kept, and rooms, functions and aliases move to the datapoint that takes the old one's place; recording settings only in some cases (see the documentation). Two things to know:

1. Make a backup before the update — going back to 1.x is not supported, the old tree is removed once it has been handed over.
2. Point your scripts and visualization at the new data points — the [documentation](docs/en/README.md#updating-from-1x) lists the new datapoint for every old ID.

## State Tree

```
homeconnect.0.
├── info.
│   ├── connection           — Signed in and live updates connected
│   ├── devicesTotal         — Appliances in your Home Connect account
│   ├── devicesOnline        — Appliances connected right now
│   └── devicesAllOnline     — Every appliance connected
├── auth.
│   ├── signedIn             — The adapter holds a usable login
│   └── lastError            — Home Connect's answer when a sign-in was refused
└── {model}-{last 4}.        — One device per appliance, e.g. sx87tx02ce-5775
    ├── info.reachable       — Appliance connected to Home Connect
    ├── status.              — Operation state, door, remaining time, progress …
    ├── settings.            — Power, child lock, temperatures … (writable)
    ├── events.              — Program finished, salt low, door alarm …
    ├── programs.
    │   ├── selectedProgram  — Program to start (writable)
    │   ├── activeProgram    — Running program
    │   ├── start            — Start the selected program (button)
    │   └── stop             — Stop the active program (button)
    ├── options.             — Program options: temperature, spin speed … (writable)
    ├── commands.            — Pause, resume, open door … (buttons)
    ├── lastRun.             — The last run: program, start, end, duration, consumption
    ├── history.             — Previous runs: latest, previous, thirdLatest …
    └── statistics.          — Runs and running time per program
```

Which channels and data points an appliance gets depends on its type. Every channel in detail: [documentation](docs/en/README.md#the-object-tree).

## Usage

1. Choose a program under `programs.selectedProgram`.
2. Adjust any `options.*` you want (e.g. temperature or delayed start).
3. Write `true` to `programs.start` to start it.

A choice can be written as its short value (`eco50`), in any capitalisation, or as the full Home Connect key; the data point confirms it in its short form.

Stop with `programs.stop`, pause and resume through the `commands.*` buttons. Settings and options are written straight back to the appliance; if the appliance rejects the options for a start, the adapter retries the start once with the program's defaults.

## Changelog

<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->

### **WORK IN PROGRESS**

- (krobipd) Changed: complete rewrite with a new object tree — every appliance gets its own readable folder and datapoints, so scripts and VIS need the new IDs (table in the documentation)
- (krobipd) Changed: values arrive as switches, numbers with units and lists in the system language instead of raw Home Connect texts; encoded program data is decoded into readable datapoints
- (krobipd) Changed: the adapter requires js-controller 7.2.2 and Admin 8.0.14 or newer now
- (krobipd) New: sign-in panel with the code, a connection test and a reset; login and Client ID of 1.x are kept, nothing has to be entered again
- (krobipd) Improved: rooms, functions and aliases move to the matching new datapoints on update, recordings where one datapoint lives on, and the login stays encrypted
- (krobipd) Fixed: the object database no longer grows with every value change (#387), and the start stays within the Home Connect request limits (#327, #58)

### 1.6.1 (2026-05-12)

- (TA2k) Login/Refresh flow improved

### 1.6.0 (2026-05-11)

- (copilot) Adapter requires node.js >= 22 now
- (copilot) Adapter requires admin >= 7.7.22 now
- (Lucky-ESA) Fixed adapter crash if URI is empty
- (Lucky-ESA) Save remaining time in active folder
- (Lucky-ESA) Device monitoring starts only after the adapter has started (this may take up to 2 minutes)

### 1.5.2 (2025-12-14)

- (Lucky-ESA) Rate limit of 50 requests per minute intercepted at adapter startup
- (Lucky-ESA) Added custom request

### 1.5.1 (2025-09-20)

- (Lucky-ESA) Fixed: Name of the objects are deleted

### 1.5.0 (2025-09-02)

- (Lucky-ESA) Clean up state roles and code
- (Lucky-ESA) Added rate limiting
- (Lucky-ESA) Dependencies updated
- (Lucky-ESA) Added language selection
- (Lucky-ESA) Migrated to ESLint 9
- (Lucky-ESA) Adapter requires js-controller >= 6.0.11 now
- (Lucky-ESA) Adapter requires admin >= 7.6.17 now
- (mcm1957) Adapter requires node.js >= 20 now

[Older changelogs can be found there](CHANGELOG_OLD.md)

## License

The MIT License (MIT)

Copyright (c) 2019-2026 TA2k <tombox2020@gmail.com>  
Copyright (c) 2024-2026 iobroker-community-adapters <iobroker-community-adapters@gmx.de>  
Copyright (c) 2026 krobi <krobi@power-dreams.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

