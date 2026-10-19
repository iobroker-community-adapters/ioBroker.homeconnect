import React from "react";

import { ConfigGeneric, type ConfigGenericProps, type ConfigGenericState } from "@iobroker/json-config";

import { DiagnosticsPanel } from "./DiagnosticsPanel";

/**
 * jsonConfig `type: custom` mount point of the diagnostics card. Must extend {@link ConfigGeneric} — the
 * admin instantiates the exposed class and drives it through `renderItem`.
 */
export default class DiagnosticsConfig extends ConfigGeneric<ConfigGenericProps, ConfigGenericState> {
  /**
   * The card itself; it owns no native field.
   *
   * @param _error unused — the card shows its own errors
   * @param _disabled unused — the card decides itself when its button is free
   * @returns the diagnostics card
   */
  renderItem(_error: string, _disabled: boolean): React.JSX.Element {
    const ctx = this.props.oContext;
    return (
      <DiagnosticsPanel
        socket={ctx.socket}
        namespace={`${ctx.adapterName}.${ctx.instance}`}
        repository="https://github.com/iobroker-community-adapters/ioBroker.homeconnect"
        tabIds={["_main", "_expert"]}
      />
    );
  }
}
