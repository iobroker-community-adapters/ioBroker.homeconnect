# <img src="https://cdn.jsdelivr.net/gh/iobroker-community-adapters/ioBroker.homeconnect@master/admin/homeconnect.svg" width="48" align="top" /> ioBroker.homeconnect

**Release:** [![npm version](https://img.shields.io/npm/v/iobroker.homeconnect)](https://www.npmjs.com/package/iobroker.homeconnect) ![stable](https://iobroker.live/badges/homeconnect-stable.svg) ![Installations](https://iobroker.live/badges/homeconnect-installed.svg) [![npm downloads](https://img.shields.io/npm/dt/iobroker.homeconnect)](https://www.npmjs.com/package/iobroker.homeconnect)

**Build:** [![Test and Release](https://github.com/iobroker-community-adapters/ioBroker.homeconnect/actions/workflows/test-and-release.yml/badge.svg)](https://github.com/iobroker-community-adapters/ioBroker.homeconnect/actions/workflows/test-and-release.yml) ![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen) ![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue) [![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

**Support:** [![Ko-fi](https://img.shields.io/badge/Ko--fi-Support-ff5e5b?logo=ko-fi)](https://ko-fi.com/krobipd) [![PayPal](https://img.shields.io/badge/Donate-PayPal-blue.svg)](https://paypal.me/krobipd)

Control and monitor your Bosch, Siemens, NEFF and Gaggenau home appliances through the official [Home Connect](https://www.home-connect.com/) cloud API — dishwashers, washers, dryers, ovens, fridges, coffee makers and more. Every value comes through in a form you can use directly, updates live, and programs can be selected, configured and started from ioBroker.

---

## Features

- **All appliance data** — status, settings, events, the active and selected program, and program options, each as an idiomatic ioBroker state.
- **A stable, complete tree** — every data point is created upfront (the event catalog of the appliance type, the options of **all** its programs) and none ever disappears: a switched-off appliance reports less, but loses nothing.
- **Live updates** through a single Home Connect event stream, so changes on the appliance show up within seconds — no polling storm.
- **Full control** — switch settings, select a program, set its options, and start, stop, pause or resume it.
- **Idiomatic values** — on/off as booleans, fixed choices as readable names with a states list, measurements as numbers with their unit and limits.
- **Encrypted login** — the OAuth token is stored encrypted and refreshed automatically; you sign in once.
- Works with Bosch, Siemens, NEFF and Gaggenau appliances (dishwashers, washers, dryers, ovens, fridges, coffee makers and more).

## Requirements

- Node.js >= 22
- js-controller >= 7.2.2
- Admin >= 8.0.14 (the sign-in panel in the settings needs Admin 8)
- A free Home Connect developer account (for a Client ID and Client Secret)

> The adapter CANNOT be installed via GitHub: The adapter must be installed via the ioBroker repository (stable or latest).

## Configuration

The adapter signs in with an application of your own in the free Home Connect Developer Program. Three things belong together: your normal Home Connect account (the one of the Home Connect app, where your appliances are paired), a developer account linked to it, and an application registered in the developer account. The settings page walks you through it with a checklist and one button per step.

1. Create a free developer account at [developer.home-connect.com](https://developer.home-connect.com/user/register). As **Default Home Connect Account for Testing** enter the e-mail address of your Home Connect app account — exactly as in the app, in **lower case**. This links the two accounts.
2. [Register an application](https://developer.home-connect.com/applications/add):
   - **Application ID:** any name, e.g. `ioBroker`
   - **OAuth Flow:** `Device Flow` — it cannot be changed later; an application with another flow has to be registered anew
   - **Success Redirect:** leave empty
   - **One Time Token Mode:** off
3. **Wait 15 to 60 minutes.** A new or edited application only becomes active at Home Connect after that — a sign-in before then is refused.
4. Copy the **Client ID** (64 characters) and the **Client Secret** into the adapter settings and save.
5. A **sign-in link** appears in the settings, together with the code it carries. Open it, sign in with your Home Connect account and confirm the code — the panel switches to **signed in** once it is done.
6. **Test connection** in the same panel asks the running adapter to make a real request to Home Connect and shows what it found: how many appliances the account lists, how many are connected right now, and whether live updates are connected — or the exact reason when something is wrong.

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

Of the settings, only the Client Secret is stored encrypted; the login itself (`auth.session`) is stored encrypted too. A login saved by another ioBroker installation (after moving to a new system) cannot be read — the log says so, and one new sign-in is needed. Home Connect in China (`api.home-connect.cn`) is not supported.

## Updating from 1.x

Version 2.0 is a new object tree: every appliance gets a readable device folder (named by its model and the last four digits of its own number) instead of the raw Home Connect tree. Your sign-in and Client ID are kept, and rooms, functions, aliases and recording settings move to the datapoint that takes the old one's place. Three things to know:

1. Make a backup before the update — going back to 1.x is not supported, the old tree is removed once it has been handed over.
2. Enter your application's **Client Secret** once in the adapter settings — the previous adapter never asked for it.
3. Point your scripts and visualization at the new data points — the [documentation](docs/en/README.md#updating-from-1x) lists the new datapoint for every old ID.

## Data points

At instance level:

| Data point | Contents |
|---|---|
| `info.connection` | Whether the adapter is signed in **and** its live event stream is connected — only then do values flow |
| `auth.signedIn` | Whether the adapter holds a usable Home Connect login (the settings panel uses it to tell "signed in, live updates down" from "not signed in") |
| `auth.lastError` | What Home Connect answered when it refused the sign-in, in its own words — empty while signed in, `Unknown` while nothing was asked yet |
| `info.devicesTotal` | How many appliances are paired with your Home Connect account |
| `info.devicesOnline` | How many of them are connected right now |
| `info.devicesAllOnline` | True only while every appliance is connected — note that household appliances are switched off most of the time, so this is a "everything is running" display rather than an alarm source |

Each paired appliance appears under a device folder named by its model and the last four characters of its own Home Connect number (e.g. `sx87tx02ce-5775`) — two appliances of the identical model get two folders, and the folder never changes. The name from your Home Connect app shows next to it as the display name and follows renames live. Each device has these channels:

| Channel | Contents |
|---|---|
| `info.reachable` | Whether the appliance is currently connected to Home Connect — this is what puts the green/grey dot on the device in the object browser |
| `status.*` | Read-only state: operation state (plus the derived boolean `programRunning`), the door as booleans (`doorOpen`, `doorLocked` on appliances whose door locks, one `door…Open` per compartment on refrigeration appliances), remote control, battery … |
| `settings.*` | **Writable** device settings: power state, child lock, temperatures, lighting … |
| `events.*` | Boolean event flags, created upfront from the appliance type's catalog: program finished/aborted, salt/rinse low, door alarm, descaling due … |
| `programs.selectedProgram` | The selected program — **writable** dropdown of the available programs (appliances without programs get no `programs` channel at all). Two programs whose names end the same get a two-part value, e.g. `heatingmode.doughproving` and `steammodes.doughproving` |
| `programs.activeProgram` | The running program (read-only, empty when idle) |
| `programs.start` / `programs.stop` | **Buttons** — start the selected program / stop the active one |
| `options.*` | **Writable** program options: temperature, spin speed, delayed start … — the union across **all** programs, created upfront; an option that does not belong to the currently selected program is simply not sent |
| `commands.*` | **Buttons** — pause, resume, open door, acknowledge event |

Values arrive in their natural form: on/off as `boolean` switches, fixed choices as short readable names with a states list, and measurements as numbers with their unit and limits.

Every data point carries a readable **name** in your ioBroker system language. The adapter's own names come first — it names the events, the common status values and settings, the program options and its own structure (channels, the online marker, the start/stop buttons, the door and running indicators) in all eleven ioBroker languages. Where it has no name of its own, it uses the localized name Home Connect sends, and as a last resort a readable name derived from the data point's id. The **description** explains what the data point means; it is never the manufacturer's key, and it stays empty where the adapter has nothing to explain. The adapter owns its data points — names, descriptions and structure — and keeps them current itself, on existing installations too; your own data points belong under `0_userdata`.

**Data points never come and go.** An appliance's capabilities do not change with its state — so a switched-off appliance keeps every data point, even though it reports only a subset (often just `powerState`) while in standby. The only thing that removes data points is removing the appliance from your Home Connect account: **an appliance you remove is removed here too**, with its whole subtree — it can no longer be addressed, so its data points could never update again. Removing happens only when Home Connect itself reports the appliance as removed — through the live event stream or a successfully read appliance list — so a network hiccup can never wipe your tree.

The adapter is also frugal with the cloud: program option definitions are fetched **once** per program and remembered (across restarts, inside the device object) — a program change or reconnect costs no extra requests.

While the adapter is stopped, every appliance shows as not reachable and `devicesOnline` drops to `0` — `devicesTotal` keeps its value, because how many appliances you own does not change because the adapter is off.

## Usage

1. Choose a program under `programs.selectedProgram`.
2. Adjust any `options.*` you want (e.g. temperature or delayed start).
3. Write `true` to `programs.start` to start it.

A choice can be written as its short value (`eco50`), in any capitalisation, or as the full Home Connect key; the data point confirms it in its short form.

Stop with `programs.stop`, pause and resume through the `commands.*` buttons. Settings and options are written straight back to the appliance; if the appliance rejects the options for a start, the program is started with its defaults instead. Everything else keeps itself up to date through the live event stream.

## Changelog

<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->

### **WORK IN PROGRESS**

- (krobipd) Changed: complete rewrite with a new object tree — every appliance gets its own readable folder and datapoints, so scripts and VIS need the new IDs (table in the documentation)
- (krobipd) Changed: values arrive as switches, numbers with units and lists in the system language instead of raw Home Connect texts; encoded program data is decoded into readable datapoints
- (krobipd) Changed: the adapter requires js-controller 7.2.2 and Admin 8.0.14 or newer now; the sign-in panel in the settings shows the live status and needs Admin 8
- (krobipd) New: sign-in panel with the code, a connection test and a reset; login and Client ID of 1.x are kept, only the Client Secret has to be entered once
- (krobipd) Improved: rooms, functions, aliases and recordings move to the matching new datapoints on update, and the stored login is kept encrypted
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

