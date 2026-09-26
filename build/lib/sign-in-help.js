"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var sign_in_help_exports = {};
__export(sign_in_help_exports, {
  looksLikeClientId: () => looksLikeClientId,
  parseRefusal: () => parseRefusal,
  refusalText: () => refusalText,
  signInHint: () => signInHint,
  signInProblem: () => signInProblem
});
module.exports = __toCommonJS(sign_in_help_exports);
function signInProblem(code, description) {
  const text = (description != null ? description : "").toLowerCase();
  switch (code) {
    case "unauthorized_client":
      if (text.includes("invalid client id")) {
        return "clientId";
      }
      if (text.includes("oauth flow") || text.includes("grant_type")) {
        return "wrongFlow";
      }
      return "notActive";
    case "invalid_client":
      return "clientSecret";
    case "access_denied":
      return "account";
    case "expired_token":
      return "codeExpired";
    case "invalid_grant":
      return "loginRevoked";
    case "invalid_scope":
      return "scope";
    default:
      return "other";
  }
}
const HINTS = {
  clientId: "Home Connect does not know this Client ID \u2014 copy it again from the developer portal (64 hexadecimal characters).",
  notActive: "Home Connect does not accept the application (yet) \u2014 a new or edited application takes 15 to 60 minutes to become active, and its status must be Enabled.",
  wrongFlow: "The application was created with another OAuth flow \u2014 create a new one with the OAuth flow 'Device Flow' (it cannot be changed afterwards).",
  clientSecret: "Home Connect rejected the Client Secret \u2014 check it in the adapter settings.",
  account: "Home Connect refused this account \u2014 check that it works in the Home Connect app (SingleKey ID, accepted terms of use).",
  codeExpired: "The sign-in code expired before it was confirmed.",
  loginRevoked: "The stored login is no longer valid \u2014 a new sign-in is needed.",
  scope: "The application may not use the requested permissions \u2014 check it in the developer portal.",
  other: "Home Connect refused the sign-in \u2014 check the Client ID and Client Secret in the adapter settings."
};
function signInHint(code, description) {
  return HINTS[signInProblem(code, description)];
}
function refusalText(code, description) {
  if (code && description) {
    return `${code}: ${description}`;
  }
  return code != null ? code : description;
}
function parseRefusal(text) {
  var _a;
  const match = /^([a-z_]+)(?::\s*(.*))?$/s.exec(text.trim());
  if (!match) {
    return { description: text.trim() || void 0 };
  }
  return { code: match[1], description: ((_a = match[2]) == null ? void 0 : _a.trim()) || void 0 };
}
function looksLikeClientId(clientId) {
  return /^[0-9A-Fa-f]{64}$/.test(clientId);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  looksLikeClientId,
  parseRefusal,
  refusalText,
  signInHint,
  signInProblem
});
//# sourceMappingURL=sign-in-help.js.map
