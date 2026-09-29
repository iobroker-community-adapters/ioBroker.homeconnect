// The id of one run in the program history (decision 48): the history counts back from the newest run, and its
// length is the appliance's — no source documents it (a washer-dryer measured four). So the ids are generated for
// any length, in words a user reads: `latest`, `previous`, `thirdLatest`, `fourthLatest` … `ninetyNinthLatest`.

const ORDINAL_UNITS = [
  "",
  "first",
  "second",
  "third",
  "fourth",
  "fifth",
  "sixth",
  "seventh",
  "eighth",
  "ninth",
  "tenth",
  "eleventh",
  "twelfth",
  "thirteenth",
  "fourteenth",
  "fifteenth",
  "sixteenth",
  "seventeenth",
  "eighteenth",
  "nineteenth",
] as const;
const CARDINAL_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"] as const;
const ORDINAL_TENS = [
  "",
  "",
  "twentieth",
  "thirtieth",
  "fortieth",
  "fiftieth",
  "sixtieth",
  "seventieth",
  "eightieth",
  "ninetieth",
] as const;

/**
 * The English ordinal word of 1 to 99, camelCase: `third`, `twentieth`, `twentyFirst`.
 *
 * @param n the number, 1 to 99
 * @returns the ordinal word
 */
function ordinalWord(n: number): string {
  if (n < 20) {
    return ORDINAL_UNITS[n];
  }
  const tens = Math.floor(n / 10);
  const unit = n % 10;
  if (unit === 0) {
    return ORDINAL_TENS[tens];
  }
  const word = ORDINAL_UNITS[unit];
  return `${CARDINAL_TENS[tens]}${word.charAt(0).toUpperCase()}${word.slice(1)}`;
}

/**
 * The channel id of the n-th run counted back from the newest.
 *
 * @param n 1 for the newest run
 * @returns `latest`, `previous`, `thirdLatest` … `ninetyNinthLatest`; beyond that `run<n>Latest`
 */
export function runSegment(n: number): string {
  if (n === 1) {
    return "latest";
  }
  if (n === 2) {
    return "previous";
  }
  if (n >= 3 && n <= 99 && Number.isInteger(n)) {
    return `${ordinalWord(n)}Latest`;
  }
  return `run${n}Latest`;
}
