# ioBroker.homeconnect

Hausgeräte von Bosch, Siemens, NEFF und Gaggenau über die offizielle Home-Connect-Cloud-API steuern und überwachen — Geschirrspüler, Waschmaschinen, Trockner, Backöfen, Kochfelder, Dunstabzugshauben, Kühl- und Gefriergeräte, Kaffeevollautomaten, Saugroboter und mehr.

Jeder Wert kommt in einer Form an, mit der sich direkt arbeiten lässt: Ein/Aus als Boolean, eine feste Auswahl als lesbarer Name, ein Messwert als Zahl mit Einheit und Grenzen. Änderungen treffen live über einen einzigen Ereignisstrom ein, und Programme lassen sich aus ioBroker heraus wählen, einstellen und starten.

## Voraussetzungen

- Node.js >= 22
- js-controller >= 7.2.2
- Admin >= 8.0.11 — das Anmelde-Panel in den Einstellungen ist eine Admin-8-Komponente
- Ein kostenloses Home-Connect-Entwicklerkonto für Client ID und Client Secret

## Zugangsdaten bei Home Connect anlegen

Drei Dinge gehören zusammen: das normale Home-Connect-Konto (das der Home-Connect-App, in dem die Geräte gekoppelt sind), ein damit verlinktes Entwicklerkonto und eine darin registrierte Anwendung. Die Einstellungsseite zeigt dieselben Schritte als Checkliste, mit einem Knopf je Schritt.

1. Auf [developer.home-connect.com](https://developer.home-connect.com/user/register) ein kostenloses Entwicklerkonto anlegen. Als **Default Home Connect Account for Testing** die E-Mail-Adresse des Home-Connect-App-Kontos eintragen — genau wie in der App, in **Kleinbuchstaben**. Das verlinkt die beiden Konten; ohne das wird die Anmeldung abgelehnt.
2. [Eine Anwendung registrieren](https://developer.home-connect.com/applications/add): **Application ID** beliebig, **OAuth Flow** `Device Flow` (der Adapter läuft auf einem Server ohne Browser; das Verfahren lässt sich später nicht ändern), **Success Redirect** leer, **One Time Token Mode** aus.
3. **15 bis 60 Minuten warten** — eine neue oder geänderte Anwendung ist erst danach bei Home Connect aktiv.
4. **Client ID** (64 Zeichen) und **Client Secret** in die Adapter-Einstellungen übernehmen und speichern.

## Anmelden

Nach dem Speichern der Zugangsdaten fordert der Adapter einen Anmelde-Link an. Das Einstellungs-Panel zeigt ihn zusammen mit dem **Code**, der zu bestätigen ist. Link öffnen, mit dem Home-Connect-Konto anmelden, Zugriff bestätigen — der Adapter merkt die Freigabe innerhalb weniger Sekunden von selbst und speichert die Anmeldung verschlüsselt. Die Benachrichtigung verweist nur auf die Einstellungen: der Code wechselt alle fünf Minuten, das Panel zeigt immer den aktuellen.

Solange der Link wartet, erneuert er sich alle fünf Minuten. Bestätigt eine Stunde lang niemand, fragt der Adapter Home Connect nicht mehr nach neuen Links; **Neuen Anmelde-Link anfordern** im Panel startet neu, ein Neustart der Instanz ebenso. **Anmeldung zurücksetzen** vergisst die Anmeldung und startet eine neue — etwa um zu einem anderen Home-Connect-Konto zu wechseln. Die Schaltfläche **Verbindung testen** fragt Home Connect wirklich: sie listet die Geräte, sagt wie viele davon gerade verbunden sind, und meldet, ob die Live-Updates laufen.

Angemeldet wird einmal. Der Adapter erneuert seinen Zugang selbst; eine neue Anmeldung ist nur nötig, wenn der Zugriff im Home-Connect-Konto widerrufen wurde, wenn Home Connect die Anwendung ablehnt (deaktiviert, gelöscht, neues Secret) oder wenn die ioBroker-Daten auf ein anderes System umgezogen sind — dort ist die gespeicherte Anmeldung nicht lesbar, und das Log sagt das.

Lehnt Home Connect die Anmeldung ab, zeigt das Panel die Antwort und was zu tun ist; `auth.lastError` hält die Antwort fest (siehe Fehlersuche).

## Der Objektbaum

Jedes Gerät bekommt einen Ordner. Sein Name ist das **Modell und die letzten vier Zeichen der eigenen Home-Connect-Nummer** des Geräts (zum Beispiel `sx87tx02ce-5775`) — unveränderlich und bei zwei Geräten desselben Modells verschieden, was weder der Gerätename aus der App noch die E-Nummer vom Typenschild ist. Der App-Name bleibt als Anzeigename des Ordners sichtbar und folgt der App live. Enden zwei Geräte eines Modells auf dieselben vier Zeichen, bekommt das zweite seine ganze Nummer.

Unter jedem Gerät:

| Kanal      | Was darin liegt                                                                                                               |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `info`     | `reachable` — ob das Gerät gerade mit Home Connect verbunden ist (der grün/graue Punkt am Ordner)                             |
| `status`   | Nur-Lese-Zustand: Betriebszustand, `doorOpen` / `doorLocked`, `programRunning`, Fernbedienungs-Marker                         |
| `settings` | Schreibbare Einstellungen: Betriebszustand, Kindersicherung, Innenbeleuchtung, Kühltemperaturen                               |
| `events`   | Jedes Ereignis dieses Gerätetyps als Boolean: Programm beendet, Salz fast leer, Klarspüler leer, Filter gesättigt, Türalarm … |
| `programs` | `selectedProgram`, `activeProgram` sowie die Schaltflächen `start` und `stop`                                                 |
| `options`  | Die Optionen der Programme: Temperatur, Schleuderdrehzahl, Intensivzone, Startverzögerung …                                   |
| `commands` | Momentschalter, die das Gerät anbietet, etwa das Quittieren eines Ereignisses                                                 |

Auf Instanzebene fassen `info.devicesTotal`, `info.devicesOnline` und `info.devicesAllOnline` das Konto zusammen; `info.connection` ist grün, wenn der Adapter angemeldet ist **und** die Live-Updates laufen, und `auth.lastError` hält die Antwort von Home Connect auf eine abgelehnte Anmeldung fest (leer, solange die Anmeldung steht; `Unknown`, solange noch nichts gefragt wurde).

Zwei Eigenschaften sind wichtig zu wissen:

- **Jeder Datenpunkt existiert ab dem ersten Start** — die Ereignisse des Gerätetyps und die Optionen _aller_ Programme, nicht nur die des gerade gewählten.
- **Kein Datenpunkt verschwindet je.** Ein ausgeschaltetes Gerät meldet der Cloud sehr viel weniger, aber das heißt nie, dass es eine Fähigkeit verloren hätte. Nur ein aus dem Home-Connect-Konto entferntes Gerät verliert seinen Ordner.

## Geräte bedienen

- **Eine Einstellung:** den Wert in den Datenpunkt unter `settings` schreiben. `"true"`, `1` und `true` funktionieren gleichermaßen — der Adapter wandelt vor dem Senden in den Typ des Datenpunkts.
- **Ein Programm starten:** in `programs.selectedProgram` wählen, die gewünschten Optionen unter `options` setzen, dann `programs.start` auf `true`. Der Adapter schickt die gewählten Optionen mit dem Start; verweigert das Gerät diese Kombination, wiederholt er einmal mit den Vorgaben des Programms.
- **Ein Programm stoppen:** `programs.stop` auf `true` setzen.
- **Einen Befehl auslösen:** die Schaltfläche unter `commands` auf `true` setzen; sie fällt von selbst auf `false` zurück.

Home Connect lässt eine Fernbedienung nur zu, wenn das Gerät es erlaubt — die meisten Maschinen brauchen dafür **Fernstart** am Gerät selbst, und viele verweigern eine Änderung, während ein Programm läuft. `status.remoteControlActive` und `status.remoteControlStartAllowed` sagen, was das Gerät gerade zulässt.

## Namen und Beschreibungen der Datenpunkte

Die eigenen Namen des Adapters gehen vor: Er benennt die Ereignisse, die üblichen Status-Werte und Einstellungen, die Programm-Optionen und seine eigene Struktur in elf Sprachen. Wo er keinen eigenen Namen hat, nimmt er den lokalisierten Namen, den Home Connect in der ioBroker-Systemsprache schickt, und zuletzt einen aus der Kennung abgeleiteten lesbaren Namen. Die Beschreibung erklärt, was ein Datenpunkt bedeutet, wiederholt nie den Herstellerbezeichner und bleibt leer, wo es nichts zu erklären gibt.

Namen und Beschreibungen gehören dem Adapter: ein Update zieht bestehende Anlagen mit, ein Baum aus einer älteren Fassung behält also keine alten Bezeichnungen. Wer eigene Benennungen will, nutzt Aliase oder eigene Datenpunkte unter `0_userdata`.

## Umstieg vom bisherigen Adapter (1.6.x und älter)

Der Adapter ersetzt den alten Datenbaum selbst: die Anmeldung wird übernommen, jedes Gerät bekommt den lesbaren Gerätebaum. Was am alten Baum hing, kommt mit — Aufzeichnungs-Einstellungen, Räume, Funktionen und Aliase ziehen zu dem Datenpunkt um, der den alten ersetzt, sobald das Gerät einmal gelesen ist. Eine Aufzeichnung setzt ihre Reihe fort, wo der Werttyp gleich geblieben ist; wo er sich geändert hat (ein Tür-Text wurde Ja/Nein), beginnt eine neue. Das Log nennt, was mitgezogen ist und was kein Gegenstück hatte.

Von Hand bleibt genau eines zu tun: **das Client Secret eintragen**. Die alte Generation kam ohne aus, es wurde deshalb nie gespeichert.

## Umstieg von 1.13 – 1.23

Die Geräte-Ordner hießen nach der E-Nummer vom Typenschild (`sx87tx02ce-60`), und die benennt nur das Modell. Mit dieser Version zieht jeder Ordner einmal auf Modell und eigene Nummer des Geräts um (`sx87tx02ce-5775`). Werte, Aufzeichnungs-Einstellungen, Räume, Funktionen und Aliase ziehen mit, aufgezeichnete Verläufe laufen in ihrer bisherigen Reihe weiter. Skripte und Visualisierungen mit den alten IDs müssen angepasst werden.

## Anfragegrenzen

Home Connect gewährt 1000 Anfragen pro Tag je Anwendung und Konto, dazu eine kurzfristige Spitzengrenze. Der Adapter ist darauf gebaut: ein dauerhafter Ereignisstrom statt Abfragen im Takt, dauerhaft gemerkte Programmdefinitionen, und eine selbsttätige Pause nach einer Grenz-Antwort. Einzustellen ist nichts — aber eine zweite eigene Anwendung mit denselben Zugangsdaten teilt sich dasselbe Kontingent.

## Fehlersuche

| Symptom                                                                                      | Ursache und Abhilfe                                                                                                                                                            |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `info.connection` bleibt rot                                                                 | Nicht angemeldet, oder der Ereignisstrom liegt. **Verbindung testen** in den Einstellungen nennt den Grund.                                                                    |
| Es erscheinen keine Geräte                                                                   | Das Entwicklerkonto muss mit dem App-Konto verlinkt sein (im Profil: Standard-Testkonto = E-Mail-Adresse der App), und die Anmeldung muss bestätigt sein.                      |
| Der Anmelde-Link funktioniert nicht                                                          | Codes laufen nach wenigen Minuten ab. Der Adapter fordert selbsttätig einen neuen an; das Einstellungs-Panel zeigt ihn von selbst.                                             |
| Es gibt keinen Anmelde-Link mehr                                                             | Eine Stunde lang hat niemand bestätigt, deshalb fragt der Adapter nicht mehr nach. **Neuen Anmelde-Link anfordern** in den Einstellungen.                                      |
| `unauthorized_client: Invalid client id`                                                     | Die Client ID ist unbekannt — noch einmal aus der Anwendung kopieren (64 Zeichen).                                                                                             |
| `unauthorized_client: request rejected by client authorization authority (developer portal)` | Die Anwendung ist noch nicht aktiv — nach dem Registrieren oder Ändern 15 bis 60 Minuten warten, prüfen, dass ihr Status Enabled ist, dann einen neuen Anmelde-Link anfordern. |
| `unauthorized_client: client not authorized for this oauth flow (grant_type)`                | Die Anwendung nutzt ein anderes OAuth-Verfahren — eine neue mit Device Flow registrieren.                                                                                      |
| `invalid_client`                                                                             | Das Client Secret wurde abgelehnt — prüfen.                                                                                                                                    |
| `access_denied`                                                                              | Das Konto wurde abgelehnt — in der Home-Connect-App prüfen (SingleKey ID, akzeptierte Nutzungsbedingungen) und ob es das im Entwicklerportal eingetragene Konto ist.           |
| In China                                                                                     | Home Connect in China (`api.home-connect.cn`) wird nicht unterstützt.                                                                                                          |
| Ein Gerät bleibt grau                                                                        | Es ist ausgeschaltet oder ohne Netz. Seine Datenpunkte bleiben mit ihren letzten Werten stehen.                                                                                |
| Ein Schreibvorgang bewirkt nichts                                                            | Das Gerät lässt gerade keine Fernbedienung zu (`status.remoteControlActive`), oder die Option gehört nicht zum gewählten Programm.                                             |
| Im Log steht „no program active"                                                             | Das ist die normale Antwort eines untätigen Geräts, kein Fehler — sie wird auf Debug-Stufe protokolliert.                                                                      |

## Unterstützung

Fragen, Fehlerberichte und Ideen: [github.com/krobipd/ioBroker.homeconnect](https://github.com/krobipd/ioBroker.homeconnect).
