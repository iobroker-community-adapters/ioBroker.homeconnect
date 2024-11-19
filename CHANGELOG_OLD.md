# Older changes
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