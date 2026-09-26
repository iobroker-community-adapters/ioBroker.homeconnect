// The object id an appliance's tree lives under — decided once, stored, never derived again.

import { slugOf } from "./pure-helpers";

/**
 * The generation of the device-id rule a device object was given its id under, written as
 * `native.idScheme` in the same write as the rest of the device object. 1 was the app name,
 * 2 the E-number from the type plate (up to 1.23.x) — both name only the MODEL, so two appliances
 * of one model differed only because the second got a suffix. 3 is the model and a piece of the
 * appliance's own number. A device object without the mark still carries an older id and moves
 * once (`migrateDeviceIds`).
 */
export const ID_SCHEME = 3;

/** Roots the instance keeps for itself — no appliance may take them. */
const RESERVED_DEVICE_IDS: ReadonlySet<string> = new Set(["auth", "info"]);

/** How many trailing characters of the piece number the id carries. */
const PIECE_TAIL = 4;

/** What an appliance tells about itself — the list record, or a stored device object's native. */
export interface ApplianceIdSource {
  /** Home Connect's own id for this one appliance. */
  haId: string;
  /** The model code (`SX87TX02CE`). */
  vib?: unknown;
  /** The E-number from the type plate (`SX87TX02CE/60`) — model plus variant. */
  enumber?: unknown;
  /** The appliance type (`Dishwasher`). */
  type?: unknown;
}

/**
 * The model half of the id: the model code, else the E-number without its variant, else the
 * appliance type, else `device`.
 *
 * @param source what the appliance tells about itself
 * @returns the id-safe model part
 */
export function modelPart(source: ApplianceIdSource): string {
  const enumberModel = typeof source.enumber === "string" ? source.enumber.split("/")[0] : undefined;
  for (const candidate of [source.vib, enumberModel, source.type]) {
    if (typeof candidate === "string") {
      const slug = slugOf(candidate.trim());
      if (slug.length > 0) {
        return slug;
      }
    }
  }
  return "device";
}

/**
 * The part of the haId that names this one appliance: the segment after the last hyphen
 * (`SIEMENS-HCS02DWH1-83D908F0FC7F` → `83d908f0fc7f`), or the whole id when it has none
 * (`015090396331005775`), letters and digits only, lower-case.
 *
 * @param haId the appliance's haId
 * @returns the piece number, or undefined when nothing usable is left
 */
export function pieceNumber(haId: string): string | undefined {
  const clean = (text: string): string => text.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  const last = clean(haId.split("-").at(-1) ?? "");
  const piece = last.length > 0 ? last : clean(haId);
  return piece.length > 0 ? piece : undefined;
}

/**
 * `base`, or `base-2`, `base-3` … — the first one that is free.
 *
 * @param base the id wanted
 * @param taken the ids other appliances hold
 * @returns a free id
 */
function counted(base: string, taken: ReadonlySet<string>): string {
  let id = base;
  for (let n = 2; taken.has(id) || RESERVED_DEVICE_IDS.has(id); n++) {
    id = `${base}-${n}`;
  }
  return id;
}

/**
 * The id an appliance gets: its model and the last four characters of its piece number
 * (`sx87tx02ce-5775`). Short, and unique: two appliances of one model differ in their number.
 * Should another appliance of the same model already hold the same four characters, this one
 * gets the whole piece number (`sx87tx02ce-015090396331015775`).
 *
 * @param source what the appliance tells about itself
 * @param taken the ids other appliances hold
 * @returns the id
 */
export function deviceIdFor(source: ApplianceIdSource, taken: ReadonlySet<string>): string {
  const model = modelPart(source);
  const piece = pieceNumber(source.haId);
  if (!piece) {
    return counted(model, taken);
  }
  const short = `${model}-${piece.slice(-PIECE_TAIL)}`;
  if (!taken.has(short)) {
    return short;
  }
  return counted(`${model}-${piece}`, taken);
}

/**
 * The root the previous adapter generation (community 1.6.x) built an appliance's tree under:
 * the haId with a trailing `-001` taken off (`main.js`, `haId.replace(/\.?-001*$/, "")`).
 *
 * @param haId the appliance's haId
 * @returns the old root id
 */
export function legacyRootOf(haId: string): string {
  return haId.replace(/\.?-001*$/, "");
}
