# ioBroker.homeconnect

Control and monitor Bosch, Siemens, NEFF and Gaggenau home appliances through the official Home Connect cloud API — dishwashers, washers, dryers, ovens, hobs, hoods, fridges, freezers, coffee makers, cleaning robots and more.

Every value arrives in a form you can use directly: on/off as a boolean, a fixed choice as a readable name, a measurement as a number with its unit and limits. Updates arrive live through a single event stream, and programs can be selected, configured and started from ioBroker.

## Requirements

- Node.js >= 22
- js-controller >= 7.2.2
- Admin >= 8.0.11 — the sign-in panel in the settings is an Admin 8 component
- A free Home Connect developer account, for a Client ID and a Client Secret

## Getting your Home Connect credentials

Three things belong together: your normal Home Connect account (the one of the Home Connect app, where your appliances are paired), a developer account linked to it, and an application registered in the developer account. The settings page shows the same steps as a checklist, with one button per step.

1. Create a free developer account at [developer.home-connect.com](https://developer.home-connect.com/user/register). As **Default Home Connect Account for Testing** enter the e-mail address of your Home Connect app account — exactly as in the app, in **lower case**. This links the two accounts; without it the sign-in is refused.
2. [Register an application](https://developer.home-connect.com/applications/add): any **Application ID**, **OAuth Flow** `Device Flow` (the adapter runs on a server without a browser; the flow cannot be changed later), **Success Redirect** empty, **One Time Token Mode** off.
3. **Wait 15 to 60 minutes** — a new or edited application only becomes active at Home Connect after that.
4. Copy the **Client ID** (64 characters) and the **Client Secret** into the adapter settings and save.

## Signing in

After saving the credentials the adapter requests a sign-in link. The settings panel shows it together with the **code** to confirm. Open the link, sign in with your Home Connect account and approve the access — the adapter picks the approval up on its own within a few seconds and stores the login encrypted. The notification only points you to the settings: the code changes every five minutes, and the panel always shows the current one.

While the link waits, it renews itself every five minutes. If nobody confirms one for an hour, the adapter stops asking Home Connect for new links; **Request a new sign-in link** in the panel starts again, and so does a restart. **Reset sign-in** forgets the login and starts a new sign-in — for example to switch to another Home Connect account. The **Test connection** button asks Home Connect directly: it lists your appliances, says how many are connected right now, and reports whether live updates are running.

You sign in once. The adapter refreshes its access by itself; a new sign-in is only needed when the access is revoked in your Home Connect account, when Home Connect refuses the application (disabled, deleted, new secret), or when the ioBroker data moved to another system — the stored login cannot be read there, and the log says so.

When Home Connect refuses the sign-in, the panel shows what it answered and what to do; `auth.lastError` keeps the answer (see Troubleshooting).

## The object tree

Each appliance gets one folder. Its name is the appliance's **model and the last four characters of its own Home Connect number** (for example `sx87tx02ce-5775`) — unchangeable, and different for two appliances of the same model, which neither the app name nor the E-number from the type plate is. The appliance name from the app stays visible as the folder's display name and follows it live. Should two appliances of one model end in the same four characters, the second one gets its whole number.

Below each appliance:

| Channel    | What is in it                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `info`     | `reachable` — whether the appliance is currently connected to Home Connect (the green/grey dot on the folder)                         |
| `status`   | Read-only appliance state: operation state, `doorOpen` / `doorLocked`, `programRunning`, remote-control flags                         |
| `settings` | Writable settings: power state, child lock, interior light, fridge temperatures                                                       |
| `events`   | Every event of this appliance type as a boolean: program finished, salt nearly empty, rinse aid empty, filter saturated, door alarm … |
| `programs` | `selectedProgram`, `activeProgram`, and the `start` / `stop` buttons                                                                  |
| `options`  | The options of the programs: temperature, spin speed, intensive zone, delayed start …                                                 |
| `commands` | Momentary buttons the appliance offers, e.g. acknowledging an event                                                                   |

At instance level, `info.devicesTotal`, `info.devicesOnline` and `info.devicesAllOnline` summarise the account, `info.connection` is green when the adapter is signed in **and** live updates are running, and `auth.lastError` holds Home Connect's answer to a refused sign-in (empty while signed in, `Unknown` while nothing was asked yet).

Two properties are worth knowing:

- **Every data point exists from the first start** — the events of the appliance type and the options of _all_ its programs, not only of the one currently selected.
- **No data point ever disappears.** A switched-off appliance reports far less to the cloud, but that never means it lost a capability. Only an appliance you remove from your Home Connect account loses its folder.

## Operating appliances

- **A setting:** write the value into the data point under `settings`. `"true"`, `1` and `true` all work — the adapter converts to the data point's type before sending.
- **Start a program:** pick it in `programs.selectedProgram`, set the options you want under `options`, then set `programs.start` to `true`. The adapter sends the selected options with the start; if the appliance refuses that combination, it retries once with the program's defaults.
- **Stop a program:** set `programs.stop` to `true`.
- **A command:** set the button under `commands` to `true`; it falls back to `false` by itself.

Home Connect only accepts remote operation when the appliance allows it — most machines need **Remote Start** enabled on the appliance itself, and many refuse a change while a program is running. `status.remoteControlActive` and `status.remoteControlStartAllowed` tell you what the appliance currently permits.

## Data point names and descriptions

The adapter's own names come first: it names the events, the common status values and settings, the program options and its own structure in eleven languages. Where it has no name of its own, it uses the localized name Home Connect sends in your ioBroker system language, and as a last resort a readable name derived from the id. The description explains what a data point means, never repeats the manufacturer's key, and stays empty where the adapter has nothing to explain.

Names and descriptions belong to the adapter: an update brings existing installations along, so a tree from an older version does not keep old labels. If you want your own naming, use aliases or your own data points under `0_userdata`.

## Updating from the previous adapter (1.6.x and older)

The adapter replaces the old data tree by itself: your login is carried over, and every appliance gets the readable device tree. What you attached to the old tree comes along — recording settings, rooms, functions and aliases move to the data point that takes the old one's place, as soon as the appliance has been read once. A recording continues its series where the value type stayed the same; where it changed (a door text became yes/no) it starts a new one. The log names what was carried and what had no counterpart.

The one thing you have to do by hand: **enter the Client Secret**. The older generation worked without one, so it was never stored.

## Updating from 1.13 – 1.23

The device folders were named after the E-number from the type plate (`sx87tx02ce-60`), which names the model only. With this version every folder moves once to the model and the appliance's own number (`sx87tx02ce-5775`). Values, recording settings, rooms, functions and aliases move along, and recorded history continues in its old series. Scripts and visualizations that use the old IDs must be updated.

## Rate limits

Home Connect grants 1000 requests per day per application and account, plus a short-term burst limit. The adapter is built around that: it uses one persistent event stream instead of polling, remembers program definitions permanently, and pauses on its own after a rate-limit answer. There is nothing to configure — but a second application of your own using the same credentials shares the same budget.

## Troubleshooting

| Symptom                                                                                      | Cause and remedy                                                                                                                                                            |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `info.connection` stays red                                                                  | Not signed in, or the event stream is down. Use **Test connection** in the settings — it names the reason.                                                                  |
| No appliances appear                                                                         | The developer account must be linked to your Home Connect app account (its profile's default testing account = the app's e-mail address), and the sign-in must be approved. |
| Sign-in link does not work                                                                   | Codes expire after a few minutes. The adapter requests a new one automatically; the settings panel shows it on its own.                                                     |
| No sign-in link any more                                                                     | Nobody confirmed a link for an hour, so the adapter stopped asking. Use **Request a new sign-in link** in the settings.                                                     |
| `unauthorized_client: Invalid client id`                                                     | The Client ID is unknown — copy it again from your application (64 characters).                                                                                             |
| `unauthorized_client: request rejected by client authorization authority (developer portal)` | The application is not active yet — wait 15 to 60 minutes after registering or editing it, check that its status is Enabled, then request a new sign-in link.               |
| `unauthorized_client: client not authorized for this oauth flow (grant_type)`                | The application uses another OAuth flow — register a new one with Device Flow.                                                                                              |
| `invalid_client`                                                                             | The Client Secret was rejected — check it.                                                                                                                                  |
| `access_denied`                                                                              | The account was refused — check it in the Home Connect app (SingleKey ID, accepted terms of use) and that it is the one entered in the developer portal.                    |
| In China                                                                                     | Home Connect in China (`api.home-connect.cn`) is not supported.                                                                                                             |
| An appliance stays grey                                                                      | It is switched off or has no network. Its data points stay and keep their last values.                                                                                      |
| A write does nothing                                                                         | The appliance permits no remote operation right now (`status.remoteControlActive`), or the program option does not belong to the selected program.                          |
| Log says "no program active"                                                                 | That is the normal answer of an idle appliance, not an error — it is logged at debug level.                                                                                 |

## Support

Questions, bug reports and ideas: [github.com/krobipd/ioBroker.homeconnect](https://github.com/krobipd/ioBroker.homeconnect).
