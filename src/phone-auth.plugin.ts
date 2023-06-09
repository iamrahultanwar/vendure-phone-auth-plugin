import {
  CustomerService,
  Logger,
  PluginCommonModule,
  TransactionalConnection,
  VendurePlugin,
} from "@vendure/core";
import { DeepPartial } from "@vendure/common/lib/shared-types";
import { VendureEntity } from "@vendure/core";
import { Column, Entity } from "typeorm";
import { Injectable, OnApplicationBootstrap } from "@nestjs/common";
import gql from "graphql-tag";
import {
  AuthenticationStrategy,
  ExternalAuthenticationService,
  Injector,
  RequestContext,
  User,
} from "@vendure/core";
import { DocumentNode } from "graphql";
import otpGenerator from "otp-generator";
import { Args, Mutation, Resolver } from "@nestjs/graphql";
import { Ctx } from "@vendure/core";
import { loggerCtx } from "./constants";

const schemaExtension = gql`
  extend type Mutation {
    requestOtp(phone: String!): String!
  }
`;

@Entity()
class PhoneOtp extends VendureEntity {
  constructor(input?: DeepPartial<PhoneOtp>) {
    super(input);
  }

  @Column()
  phone: string;

  @Column()
  otp: string;

  @Column()
  verified: boolean;
}

@Injectable()
class PhoneAuthService implements OnApplicationBootstrap {
  constructor(private connection: TransactionalConnection) { }

  async onApplicationBootstrap() {
    if (!PhoneAuthPlugin.options?.sendOtp) {
      Logger.warn(
        "sendOtp is not defined, please define it in the plugin options",
        loggerCtx
      );
    }
  }

  /**
   * @description Request OTP
   * @param ctx - RequestContext
   * @param phone - phone number
   * @param otp - otp
   * @returns string
   *
   */
  async requestOtp(ctx: RequestContext, phone: string, otp: string) {
    const phoneOtp = new PhoneOtp();
    phoneOtp.phone = phone;

    // added config for otp generator
    if (PhoneAuthPlugin.options?.otpGeneratorOptions && PhoneAuthPlugin.options?.otpGeneratorOptions.length) {
      phoneOtp.otp = otpGenerator.generate(PhoneAuthPlugin.options?.otpGeneratorOptions.length, {
        upperCaseAlphabets: PhoneAuthPlugin.options?.otpGeneratorOptions.upperCaseAlphabets || false,
        specialChars: PhoneAuthPlugin.options?.otpGeneratorOptions.specialChars || false,
        digits: PhoneAuthPlugin.options?.otpGeneratorOptions.digits || true,
        lowerCaseAlphabets: PhoneAuthPlugin.options?.otpGeneratorOptions.lowerCaseAlphabets || false,
      });
    } else {
      phoneOtp.otp = otpGenerator.generate(6, {
        upperCaseAlphabets: false,
        specialChars: false,
        digits: true,
        lowerCaseAlphabets: false,
      });
    }

    phoneOtp.verified = false;

    if (PhoneAuthPlugin.options?.sendOtp) {
      try {
        await PhoneAuthPlugin.options.sendOtp(phoneOtp.phone, phoneOtp.otp);
        await this.connection.getRepository(ctx, PhoneOtp).save(phoneOtp);
        return "OTP sent successfully, please verify";
      } catch (error: any) {
        Logger.error(error, loggerCtx);
      }
    } else {
      await this.connection.getRepository(ctx, PhoneOtp).save(phoneOtp);

      return "OTP sent successfully, please verify";
    }
  }

  /**
   * @description Verify OTP
   * @param ctx - RequestContext
   * @param phone - phone number
   * @param otp - otp
   * @returns boolean
   * */
  async verifyOtp(ctx: RequestContext, phone: string, otp: string) {
    const phoneOtp = new PhoneOtp();
    phoneOtp.phone = phone;
    phoneOtp.otp = otp;
    phoneOtp.verified = false;

    const phoneOtpData = await this.connection
      .getRepository(ctx, PhoneOtp)
      .findOne(phoneOtp);
    if (phoneOtpData) {
      await this.connection
        .getRepository(ctx, PhoneOtp)
        .update(phoneOtpData.id, { verified: true });
      return true;
    } else {
      return false;
    }
  }

  getDefaultUserData(phone: string) {
    return PhoneAuthPlugin.options.defaultUserDataBuilder(phone);
  }
}

@Resolver()
class PhoneAuthResolver {
  constructor(private phoneAuthService: PhoneAuthService) { }

  @Mutation()
  requestOtp(@Ctx() ctx: RequestContext, @Args() args: any) {
    return this.phoneAuthService.requestOtp(ctx, args.phone, args.otp);
  }
}
export type PhoneAuthData = {
  phone: string;
  otp: string;
};

export class PhoneAuthenticationStrategy
  implements AuthenticationStrategy<PhoneAuthData>
{
  readonly name = "phone";
  private externalAuthenticationService: ExternalAuthenticationService;
  private phoneAuthService: PhoneAuthService;
  private customerService: CustomerService;

  constructor() { }

  init(injector: Injector) {
    this.externalAuthenticationService = injector.get(
      ExternalAuthenticationService
    );
    this.phoneAuthService = injector.get(PhoneAuthService);
    this.customerService = injector.get(CustomerService);
  }

  defineInputType(): DocumentNode {
    return gql`
      input PhoneAuthInput {
        phone: String!
        otp: String!
      }
    `;
  }

  async authenticate(
    ctx: RequestContext,
    data: PhoneAuthData
  ): Promise<User | false | string> {
    const verified = await this.phoneAuthService.verifyOtp(
      ctx,
      data.phone,
      data.otp
    );
    if (!verified) {
      return "Invalid OTP";
    }
    const user = await this.externalAuthenticationService.findCustomerUser(
      ctx,
      this.name,
      data.phone
    );
    if (user) {
      return user;
    }

    const defaultUserData = this.phoneAuthService.getDefaultUserData(
      data.phone
    );

    if (defaultUserData.emailAddress.length === 0) {
      Logger.error("Valid default email address is required", loggerCtx);
      return "Valid default email address is required";
    }

    try {
      const newCustomer =
        await this.externalAuthenticationService.createCustomerAndUser(ctx, {
          strategy: this.name,
          externalIdentifier: data.phone,
          verified: true,
          emailAddress: defaultUserData.emailAddress,
          firstName: defaultUserData.firstName,
          lastName: defaultUserData.lastName,
        });

      const customer = await this.customerService.findOneByUserId(
        ctx,
        newCustomer.id
      );
      if (!customer) return Promise.reject("Customer not found");

      await this.customerService.update(ctx, {
        id: customer.id,
        phoneNumber: data.phone,
        firstName: data.phone,
      });

      return newCustomer;
    } catch (error) {
      return Promise.reject(error);
    }
  }
}

export interface PhoneAuthPluginOptions {
  sendOtp?: (phone: string, otp: string) => Promise<any>;
  defaultUserDataBuilder: (phone: string) => {
    emailAddress: string;
    firstName: string;
    lastName: string;
  };
  otpGeneratorOptions?: {
    length?: number;
    upperCaseAlphabets?: boolean;
    specialChars?: boolean;
    digits?: boolean;
    lowerCaseAlphabets?: boolean;
  }

}

@VendurePlugin({
  imports: [PluginCommonModule],
  entities: [PhoneOtp],
  providers: [PhoneAuthService],
  shopApiExtensions: {
    schema: schemaExtension,
    resolvers: [PhoneAuthResolver],
  },
  configuration: (config) => {
    config.authOptions.shopAuthenticationStrategy.push(
      new PhoneAuthenticationStrategy()
    );
    return config;
  },
})
export class PhoneAuthPlugin {
  static options: PhoneAuthPluginOptions;

  static init(options: PhoneAuthPluginOptions): typeof PhoneAuthPlugin {
    this.options = options;
    return PhoneAuthPlugin;
  }
}
