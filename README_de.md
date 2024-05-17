![Logo](admin/homeconnect.png)

# ioBroker.homeconnect

[![GitHub license](https://img.shields.io/github/license/iobroker-community-adapters/ioBroker.homeconnect)](https://github.com/iobroker-community-adapters/ioBroker.homeconnect/blob/main/LICENSE)
[![Downloads](https://img.shields.io/npm/dm/iobroker.homeconnect.svg)](https://www.npmjs.com/package/iobroker.homeconnect)
![GitHub repo size](https://img.shields.io/github/repo-size/iobroker-community-adapters/ioBroker.homeconnect)
[![Translation status](https://weblate.iobroker.net/widgets/adapters/-/homeconnect/svg-badge.svg)](https://weblate.iobroker.net/engage/adapters/?utm_source=widget)</br>
![GitHub commit activity](https://img.shields.io/github/commit-activity/m/iobroker-community-adapters/ioBroker.homeconnect)
![GitHub commits since latest release (by date)](https://img.shields.io/github/commits-since/iobroker-community-adapters/ioBroker.homeconnect/latest)
![GitHub last commit](https://img.shields.io/github/last-commit/iobroker-community-adapters/ioBroker.homeconnect)
![GitHub issues](https://img.shields.io/github/issues/iobroker-community-adapters/ioBroker.homeconnect)
</br>
**Version:** </br>
[![NPM version](http://img.shields.io/npm/v/iobroker.homeconnect.svg)](https://www.npmjs.com/package/iobroker.homeconnect)
![Current version in stable repository](https://iobroker.live/badges/homeconnect-stable.svg)
![Number of Installations](https://iobroker.live/badges/homeconnect-installed.svg)
</br>
**Tests:** </br>
[![Test and Release](https://github.com/iobroker-community-adapters/ioBroker.homeconnect/actions/workflows/test-and-release.yml/badge.svg)](https://github.com/iobroker-community-adapters/ioBroker.homeconnect/actions/workflows/test-and-release.yml)
[![CodeQL](https://github.com/iobroker-community-adapters/ioBroker.homeconnect/actions/workflows/codeql.yml/badge.svg)](https://github.com/iobroker-community-adapters/ioBroker.homeconnect/actions/workflows/codeql.yml)

## Sentry
**This adapter uses Sentry libraries to automatically report exceptions and code errors to the developers.**
For more details and for information how to disable the error reporting see [Sentry-Plugin Documentation](https://github.com/ioBroker/plugin-sentry#plugin-sentry)! Sentry reporting is used starting with js-controller 3.0.

## Homeconnect Adapter for ioBroker

## Voraussetzungen vor der Installation

Es muß mindestens Node.js Version 18 installiert sein!!

Für den Adapter wird eine ClientID benötigt. Nutze die Einstellungen um jeden Schritt der Registrierung zu erreichen.

<https://developer.home-connect.com>

![Screenshot](img/registrierung1.JPG)

Bei **Default Home Connect User Account for Testing** die E-Mail-Adresse angeben, mit der die Home-Connect-App
registriert wurde, diese wird später auch beim Authorization-Prozess benötigt.

![Screenshot](img/registrierung2.JPG)

Bei **Account Type** Individual auswählen. Die restlichen Daten sofern vorhanden ergänzen (keine Ahnung, ob das geprüft wird).

![Screenshot](img/application1.JPG)

Dann auf **Applications** und anschließend auf **Register Application** gehen.

![Screenshot](img/application2.JPG)

Bei **Application ID** einen Namen für die Application eintragen, z.B. ioBroker. Bei **OAuth Flow** Device Flow selektieren.
**Home Connect User Account for Testing** kann leer bleiben. Bei **Success Redirect** eine URI eintragen, z.B. https://example.com.
Dann Speichern und dann hat man die benötigte ClientID.

## Konfiguration

In der Adapter-Config muss der Homeconnect App Benutzername und Passwort und die erstellte ClientID eingetragen werden.

## Benutzung

Mit den states in commands kannst du das Programm stoppen, pausieren oder fortführen.

Mit den states in settings kannst du das Gerät ein oder ausschalten.

Ändern des States programs.active.BSH_Common_Root_ActiveProgram führt zum starten eines Programms
Update iQ300: Es muss das gewüschnte Programm eingetragen werden. Wenn man programs.selected.BSH_Common_Root_SelectedProgram ausliest und einträgt, hat der User die Möglichkeit am Gerät des gewünschte Programm auszuwählen, welches dann per ioBroker gestartet wird.

Ändern des States programs.selected.BSH_Common_Root_SelectedProgram führt zum auswählen des Programms oder Optionen

Wenn man checken möchte, ob ein Programm fertig ist muss

status.BSH_Common_Status_OperationState

auf den kompletten Status Name übrprüft werden:

BSH.Common.EnumType.OperationState.Finished

Weitere Zustände sind noch:

"BSH.Common.EnumType.OperationState.Inactive": "Inactive",
"BSH.Common.EnumType.OperationState.Ready": "Ready",
"BSH.Common.EnumType.OperationState.Run": "Run",
"BSH.Common.EnumType.OperationState.ActionRequired": "ActionRequired",
"BSH.Common.EnumType.OperationState.Finished": "Finished"

Oder ob ein Gerät geöffnet ist

"BSH.Common.EnumType.DoorState.Open": "Open",
"BSH.Common.EnumType.DoorState.Closed": "Closed"

## Changelog

Der Changelog findet sich in der englischen README.md Datei.

## License

The MIT License (MIT)

Copyright (c) 2024 iobroker-community-adapters <iobroker-community-adapters@gmx.de>
Copyright (c) 2023 dna909 <dna909@googlemail.com>, TA2k

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
