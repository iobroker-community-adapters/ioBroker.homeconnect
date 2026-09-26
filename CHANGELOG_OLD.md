# Older changes

## 1.19.1 (2026-09-14)

- Fixed: the appliance pictograms of 1.19.0 were invisible in the dark Admin themes. They now follow the theme and read everywhere; existing devices get the corrected icon on the first sync.

## 1.19.0 (2026-09-12)

- New: every appliance now carries a pictogram of its type in the object tree - dishwasher, oven, washing machine and fourteen more, drawn to read in the light and the dark theme.

## 1.18.2 (2026-09-12)

- Fixed: six data points of the extended Home Connect data access - the lifetime counters and the detergent drawer event - showed an English label and no description. They are named and explained now.

## 1.18.1 (2026-09-12)

- Fixed: no appliance shows two data points under the same name any more - the power state and the operating state, two oven preheat events and two chiller doors collided.

## 1.18.0 (2026-09-12)

- Fixed: appliances can be switched on again - the adapter now reads each setting's allowed values. Until now only the current value could be written, so an appliance at "off" stayed off.
- Fixed: numeric settings such as a freezer's target temperature carry the minimum, maximum and step size the appliance declares, so Admin and VIS show a proper range instead of an open number field.
- Fixed: a setting no longer offers values the appliance rejects - picking one of those did nothing at all.
- Fixed: data point names are in your language throughout. Home Connect answers some names in English whatever language is requested, so the adapter's own text now wins wherever it has one.
- Fixed: a stopped instance no longer reports itself as signed in.
- Fixed: a status message that arrives without a value leaves the stored reading alone instead of emptying it.
- Fixed: deselecting a program on the appliance no longer sends that program's options to the cloud.
- Fixed: after a live-connection outage, "re-read the appliances" is only logged when the appliances were really re-read - and a failed attempt no longer blocks the next one for an hour.
- Fixed: "all appliances connected" no longer flickers to true for a moment while the first appliance of a fresh installation is being set up.
- Fixed: fewer unnecessary object writes - an appliance whose data has not changed is no longer rewritten on every refresh.

## 1.17.1 (2026-09-07)

- Fixed: installing the adapter from GitHub works again — with 1.17.0 the instance stayed dead after such an installation.
- New: the extra data points of the extended Home Connect data access carry a name and a short explanation in your language.

## 1.17.0 (2026-09-07)

- Fixed: after the live connection was interrupted, the adapter reads every appliance again — until now the values stayed at the state from before the outage while the instance looked connected.
- Fixed: a program you select on the appliance itself now unlocks that program's options — until now writing them was silently ignored and a start sent the previous program's options.
- Fixed: a refreshed sign-in that could not be stored is now reported and written again later — until now it was logged as "login kept" and the next restart asked for a new sign-in.
- Fixed: a data point whose name could not be written is retried in the same run instead of keeping the bare id until the next restart.
- Fixed: the explanation of a command no longer disappears when its name comes from Home Connect or from the adapter's own fallback.
- New: 81 more status and setting data points carry a name in your language — until now an appliance that was switched off showed English labels there.
- New: every data point now carries a short explanation in your language, including the program options of appliances you do not own — until now only a good third of them had one.

## 1.16.1 (2026-09-04)

- Fixed: the compartment doors of a fridge or freezer are named in your language again — until now the compartment itself stayed in English in an otherwise translated name.

## 1.16.0 (2026-09-04)

- Fixed: the door and "program running" data points keep their own name and explanation again — an update had given them the name of the underlying appliance value, two of them even the same one.
- Fixed: a failed object update no longer leaves a setting with an empty selection list until the next restart.
- Fixed: an account that briefly reports no appliance at all no longer removes every device folder.
- New: program options now carry a name in your language even while the appliance is switched off — until now they showed an English name there.
- Improved: the adapter's own data points for sign-in and information now get their current name and description on existing installations too.
- Fixed: an instance stopped right after it started no longer leaves its appliances showing as connected in the object tree.

## 1.15.0 (2026-09-02)

- New: every event has a name and a short explanation in your language — salt empty, rinse aid nearly empty, filter saturated — for all seventeen appliance types, from the very first start.
- New: the description now explains what a datapoint means instead of repeating the manufacturer's key, and where the adapter has nothing to explain it stays empty.
- Fixed: after an update, the event datapoints, the online marker and the channels kept the bare id as name — they are named properly now.
- Fixed: options of a program that is not currently selected keep the bare id no longer — their names come from Home Connect once more after the update.

## 1.14.0 (2026-09-02)

- New: every data point now carries a readable name in your language, straight from Home Connect, plus its technical key as description — no more bare ids in the object browser.
- New: channels, the online marker and the start/stop buttons are named in all eleven ioBroker languages, and the adapter keeps every name and description current itself on every update.
- Fixed: the instance no longer shows as connected while its live updates are down — a routine token refresh used to switch it to connected for a moment.
- Fixed: a login the event stream rejects is refreshed right away, so live updates no longer stay silent for up to a day after the token was revoked on the server side.
- Fixed: a text value written by a script into a switch or a number is now sent to the appliance as the proper on/off or number and confirmed in that form.
- Fixed: live updates that stall while connecting now recover on their own — until now such an attempt could hang until the instance was restarted, with no data arriving.
- Fixed: an appliance whose name in the app contains unusual characters now gets a clean device name instead of a broken one.
- New: a Test connection button in the settings makes a real request to Home Connect and tells you what it found — appliances listed and connected, live updates up or the exact reason why not.

## 1.13.0 (2026-09-01)

- Changed: device folders are now named by the type plate's E-number (e.g. `sx87tx02ce-60`); existing trees move automatically with values, history settings and renames — update your script ids once
- Changed: the appliance name from the app remains the displayed device name; two identical models are told apart by a serial-based suffix in the folder id
- Fixed: idle appliances no longer produce warnings at adapter start, and a quick stop right after start no longer leaves stale online markers behind

## 1.12.0 (2026-09-01)

- Fixed: data points no longer vanish while an appliance is switched off — a standby appliance reports only a subset, which used to delete the child lock. Only unpairing an appliance removes anything.
- New: everything is created upfront — the event catalog of your appliance type and the settable values of all its programs, so no data point appears only on first use.
- New: doors are real on/off states — open, locked where the door locks, and one per fridge compartment — and a running indicator shows at a glance whether a program is active.
- Fixed: nested appliance data such as fridge doors and lighting sat in a wrong misc folder and was read-only there — everything moves to its real place automatically, history settings included.
- New: appliances going online or offline are logged, and program details are fetched only once — program changes and reconnects no longer cost cloud requests.
- New: the settings page links straight to the Home Connect developer portal and explains where upgraders find the client secret of an existing application.

## 1.11.0 (2026-08-27)

- New: your appliances now show the green/grey icon in the object browser — the reachable value was already there, it just was not linked to the icon.
- New: three data points show how many appliances are paired, how many are connected right now, and whether all of them are.
- Fixed: stopping the adapter no longer leaves every appliance showing as connected, and a start-up without a working sign-in no longer keeps the old values.
- Changed: an appliance you remove from your Home Connect account is now removed here too, with its whole subtree. Switching an appliance off keeps it, as before.

## 1.10.0 (2026-08-22)

- Fixed: Stopping or restarting the instance now really ends the sign-in; the adapter no longer keeps contacting Home Connect after it has shut down.

## 1.9.0 (2026-08-18)

- New: after an update from the previous adapter generation only the readable device tree remains — no left-over raw entries, and you stay signed in.
- New: each appliance now shows whether it is currently online, so stale values are recognizable at a glance.
- New: newly available programs, changed option ranges and units now show up on existing installations — no need to delete objects first.
- Fixed: when the Home Connect login is revoked, the adapter asks for a fresh sign-in by itself (link in the settings, notification and log) instead of staying silent until a restart.
- Fixed: the sign-in link in the settings renews itself when it expires, so it always works when you open it.
- Fixed: settings the appliance declares as read-only are no longer offered as switchable.
- Improved: number values carry the appliance's allowed step size, and device names with accented letters get clean object paths.
- Improved: clearer logging — a brief cloud outage no longer claims that no appliances were found, recoveries are reported, and a write dropped during a rate-limit pause is visible.

## 1.8.0 (2026-08-11)

- New: the Home Connect sign-in now happens right in the adapter settings — the one-time link and a live "signed in" status appear there, and also as a notification.
- Sign-in is more robust: a brief network problem during a restart no longer asks you to sign in again, and an expired access token is refreshed automatically instead of failing silently.
- Writing settings, options or programs works again immediately after an adapter restart, even while the appliance is switched off.
- More stable when the Home Connect cloud is briefly unreachable or busy — the adapter backs off and recovers on its own instead of hammering it.
- Requires Admin 8 now (the settings sign-in panel is an Admin-8 component).

## 1.7.1 (2026-08-06)

- Fixed the repository links and adapter logo so they resolve to the correct place.

## 1.7.0 (2026-08-06)

- Complete rewrite. Every value now arrives ready to use: on/off as switches, fixed choices as readable names, and temperatures and times as numbers with their unit.
- Programs, status and events update live through a single connection, so changes on the appliance show up in ioBroker within seconds instead of on a poll.
- Full program control: select a program, set options such as temperature, spin speed or delayed start, then start, stop or pause it from ioBroker.
- Every data point now has a short, readable name, so appliance values are easy to find and use in scripts, charts and visualisations.

## 1.6.1 (2026-05-12) — stable

- (TA2k) Login/Refresh flow improved

## 1.6.0 (2026-05-11)

- (copilot) Adapter requires node.js >= 22 now
- (copilot) Adapter requires admin >= 7.7.22 now
- (Lucky-ESA) Fixed adapter crash if URI is empty
- (Lucky-ESA) Save remaining time in active folder
- (Lucky-ESA) Device monitoring starts only after the adapter has started (this may take up to 2 minutes)

## 1.5.2 (2025-12-14)

- (Lucky-ESA) Rate limit of 50 requests per minute intercepted at adapter startup
- (Lucky-ESA) Added custom request

## 1.5.1 (2025-09-20)

- (Lucky-ESA) Fixed: Name of the objects are deleted

## 1.5.0 (2025-09-02)

- (Lucky-ESA) Clean up state roles and code
- (Lucky-ESA) Added rate limiting
- (Lucky-ESA) Dependencies updated
- (Lucky-ESA) Added language selection
- (Lucky-ESA) Migrated to ESLint 9
- (Lucky-ESA) Adapter requires js-controller >= 6.0.11 now
- (Lucky-ESA) Adapter requires admin >= 7.6.17 now
- (mcm1957) Adapter requires node.js >= 20 now

## 1.4.3 (2024-11-19)

- (TA2k) fix for -001 devices
- (simatec) Adapter has been adapted to meet Responsive Design rules.

## 1.4.2 (2024-10-25)

- (TA2k) fix for devices with object values

## 1.4.1 (2024-07-02)

- (foxriver76) fixed invalid min/max values

## 1.4.0 (2024-04-18)

- (mcm1957) Adapter requires node.js >= 18 and js-controller >= 5 now
- (mcm1957) Dependencies have been updated

## 1.3.0 (2023-12-15)

- fix login

## 1.2.2 (2023-12-02)

- bump version

## 1.2.1 (2023-12-02)

- bump version

## 1.2.0 (2023-12-02)

- fix login flow
- (mcm1957) changed: Testing has been changed to support node 16, 18 and 20
- (mcm1957) changed: Dependencies have been updated
- (ta2k) restart adapter instead of relogin

## 1.1.1

- Fix auto login for SingleKey User

## 1.1.0

- Add auto login for SingleKey User

## 1.0.3

- Add manually login for SingleKey User

## 1.0.2

- Adapter complete rewriten. Includes a lot of Bugfixes

## 0.0.36

- fix for js.controller 3.3. Please delete the device in Objects manually

## 0.0.32 (29.12.2020)

- (Morluktom) bugfix for devices that are completely switched off (e.g. washing machine, dryer)

## 0.0.31

- (ta2k) fix pause start command

## 0.0.30 (10.05.2020)

- (ta2k) fix js controller 3 issues

## 0.0.27 (13.11.2019)

- (ta2k) improve option selecting

## 0.0.26 (04.11.2019)

- (ta2k) fix boolean settings

## 0.0.25 (08.09.2019)

- (ta2k) fix compact mode
- (ta2k) reduce query per minute to prevent too much request error

## 0.0.24 (08.09.2019)

- (ta2k) improve error messaging

## 0.0.22 (08.09.2019)

- (ta2k) improve error messaging

## 0.0.22 (26.07.2019)

- (ta2k) bugfixing

## 0.0.21 (12.07.2019)

- (ta2k) bugfixing

## 0.0.19 (30.06.2019)

- (ta2k) improve displaying long states, options and events

## 0.0.18 (26.06.2019)

- (ta2k) add error handling for stoping

## 0.0.17 (26.06.2019)

- (ta2k) make commands writeable

## 0.0.16 (26.06.2019)

- (ta2k) cleanup states after update

## 0.0.15 (24.06.2019)

- (ta2k) reconnect after token refresh

## 0.0.14 (18.06.2019)

- (ta2k) check for keep alive events

## 0.0.13 (18.06.2019)

- (ta2k) close event stream before reconnect

## 0.0.12 (18.06.2019)

- (ta2k) fix events lost after 12hr

## 0.0.11 (09.06.2019)

- (ta2k) fix set values and refresh available options after program select

## 0.0.10 (04.06.2019)

- (ta2k) add settings and commands, add options to available and fix bugs

## 0.0.9 (29.05.2019)

- (ta2k) clean up code and receive event notifications

## 0.0.8 (10.04.2019)

- (dna909) increase refreshTokenInterval

## 0.0.7 (03.04.2019)

- (TA2k) Improve refreshToken and add Register process in instance option

## 0.0.6 (09.01.2019)

- (dna909) Oven: add Option.FastPreHeat, Logging, query stream.type DISCONNECTED
- (tFaster) code format and cleanups,fixed devices data structure,renamed deviceArray to devices,
  added startInRelative for Oven

## 0.0.5 (28.11.2018)

- (dna909) add eventstream handling

## 0.0.4 (23.11.2018)

- (dna909) add event-listener

## 0.0.3 (14.11.2018)

- (dna909) query States and available programs

## 0.0.2 (08.11.2018)

- (dna909) OAuth2 Deviceflow-Authorization, enumerate connected appliances

## 0.0.1 (09.10.2018)

- (dna909) initial release