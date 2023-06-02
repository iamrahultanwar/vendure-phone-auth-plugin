# Vendure Phone Auth Plugin

This plugin adds phone authentication to the Vendure GraphQL API.

## Installation

```bash
  yarn add vendure-phone-auth-plugin
```

## Usage

```ts
import { PhoneAuthPlugin } from "vendure-phone-auth-plugin";

export const config: VendureConfig = {
  // ...
  plugins: [
    // ...
    PhoneAuthPlugin.init({
      sendOtp: async (phone, otp) => {
        Logger.info(`${otp} sent to ${phone}`, "PhoneAuthPlugin");
        try {
          await thirdPartySms(otp, phone);
          return Promise.resolve(true);
        } catch (error) {
          return Promise.resolve(false);
        }
      },
      defaultUserDataBuilder(phone) {
        return {
          emailAddress: `${phone}@example.com`, // you can use your own logic here
          firstName: "",
          lastName: "",
        };
      },
    }),
  ],
};
```
