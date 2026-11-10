// Auto-typed adapter config — mirror of io-package.json "native".

declare global {
  namespace ioBroker {
    interface AdapterConfig {
      /** Home Connect developer application client ID. */
      clientID: string;
      /** Home Connect developer application client secret (encrypted native). */
      clientSecret: string;
      /** The way the instance signs in: `api` (developer access, default) or `app` (the Home Connect app's client, beta). */
      accessMode?: string;
    }

    /**
     * Custom notification scope declared in io-package.json `notifications`.
     * Lets `registerNotification("homeconnect", "userActionRequired", …)`
     * type-check without a cast. The category surfaces the sign-in prompt.
     */
    interface NotificationScopes {
      homeconnect: "userActionRequired";
    }
  }
}

export {};
