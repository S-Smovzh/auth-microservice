import { ClientProxy, ClientProxyFactory, RpcException, Transport } from "@nestjs/microservices";
import { HttpStatus, Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Observable } from "rxjs";
import { Model, Types } from "mongoose";
import crypto from "crypto";
import argon2 from "argon2";
import { v4 } from "uuid";
import { ValidationErrorCodes } from "../exceptions/errorCodes/ValidationErrorCodes";
import { GlobalErrorCodes } from "../exceptions/errorCodes/GlobalErrorCodes";
import { UserErrorCodes } from "../exceptions/errorCodes/UserErrorCodes";
import { JWTTokens } from "../token/interfaces/jwt-token.interface";
import { TokenService } from "../token/token.service";
import { UserLoginEmailError, UserLoginPhoneNumberError, UserLoginUsernameError } from "./interfaces/user-log-in.interface";
import { LoginByEmailDto, LoginByPhoneNumberDto, LoginByUsernameDto } from "./dto/login.dto";
import { IpAgentFingerprint, RequestInfo } from "./interfaces/request-info.interface";
import { AddOrUpdateOptionalDataDto } from "./dto/add-or-update-optional-data.dto";
import { ChangePrimaryDataDocument } from "./schemas/change-primary-data.schema";
import { PasswordChangeError } from "./interfaces/change-password.interface";
import { UsernameChangeError } from "./interfaces/change-username.interface";
import { ForgotPasswordDocument } from "./schemas/forgot-password.schema";
import { InternalFailure } from "./interfaces/internal-failure.interface";
import { VerifyPasswordResetDto } from "./dto/verify-password-reset.dto";
import { EmailChangeError } from "./interfaces/change-email.interface";
import { PhoneChangeError } from "./interfaces/change-phone.interface";
import { UserSignUpError } from "./interfaces/user-sign-up.interface";
import { ChangePasswordDto } from "./dto/update-password.dto";
import { ChangePhoneNumberDto } from "./dto/update-phone.dto";
import { ForgotPasswordDto } from "./dto/forgot-password.dto";
import { ChangeUsernameDto } from "./dto/update-username.dto";
import { ChangeEmailDto } from "./dto/update-email.dto";
import { VaultDocument } from "./schemas/vault.schema";
import { UserDocument } from "./schemas/user.schema";
import { SignUpDto } from "./dto/sign-up.dto";
import { UserData } from "./interfaces/user-data";

const ms = require("ms");
const cloudinary = require("cloudinary").v2;

@Injectable()
export class UserService {
  client: ClientProxy;

  constructor(
    @InjectModel("User")
    private readonly userModel: Model<UserDocument>,
    @InjectModel("Vault")
    private readonly vaultModel: Model<VaultDocument>,
    @InjectModel("Forgot-Password")
    private readonly forgotPasswordModel: Model<ForgotPasswordDocument>,
    @InjectModel("Change-Primary-Data")
    private readonly changePrimaryDataDocumentModel: Model<ChangePrimaryDataDocument>,
    private readonly authService: TokenService
  ) {
    this.client = ClientProxyFactory.create({
      transport: Transport.REDIS,
      options: {
        url: `redis://${process.env.REDIS_DB_NAME}:${process.env.REDIS_PASSWORD}@${process.env.REDIS_ENDPOINT}:${process.env.REDIS_PORT}`,
        retryDelay: 3000,
        retryAttempts: 10
      }
    });
  }

  private counter = 0;

  async register(userSignUpDto: SignUpDto): Promise<HttpStatus | Observable<any> | RpcException> {
    const error: Partial<UserSignUpError> = {};

    try {
      if (await this._isExistingEmail(userSignUpDto.email)) {
        error.email = ValidationErrorCodes.EMAIL_ALREADY_EXISTS.value;
      }
      if (await this._isExistingUsername(userSignUpDto.username)) {
        error.username = ValidationErrorCodes.USERNAME_ALREADY_EXISTS.value;
      }
      if (!(await this._validatePasswordUniqueness(userSignUpDto.password))) {
        error.password = ValidationErrorCodes.INVALID_PASSWORD.value;
      }
      if (await this._isExistingPhone(userSignUpDto.phoneNumber)) {
        error.phoneNumber = ValidationErrorCodes.TEL_NUM_ALREADY_EXISTS.value;
      }
      if (!this._isEmpty(error)) {
        return new RpcException(error);
      }

      if (userSignUpDto.password === userSignUpDto.passwordVerification) {
        delete userSignUpDto.passwordVerification;
        const salt = crypto.randomBytes(10).toString("hex");
        userSignUpDto.password = await this._generatePassword(userSignUpDto.password, salt);

        const user = new this.userModel(userSignUpDto);
        const vault = new this.vaultModel({ user: user._id, salt });

        if (!vault) {
          return new RpcException({
            key: "INTERNAL_ERROR",
            code: GlobalErrorCodes.INTERNAL_ERROR.code,
            message: GlobalErrorCodes.INTERNAL_ERROR.value
          });
        }

        user.verification = v4();
        user.save((e) => {
          if (e) {
            console.log(e);
            return;
          }
        });
        await vault.save();

        await this.client.send({ cmd: "add-welcome-chat" }, { user: user._id });

        return await this.client.send(
          { cmd: "verify" },
          { verificationCode: user.verification, email: user.email, mailType: "VERIFY_EMAIL" }
        );
      }
    } catch (e) {
      return new RpcException(e);
    }
  }

  async verifyRegistration({
    email,
    verification
  }: {
    email: string;
    verification: string;
  }): Promise<HttpStatus | Observable<any> | RpcException> {
    try {
      const user = await this.userModel.exists({
        email,
        isActive: false,
        verification
      });

      if (user) {
        await this.userModel.updateOne(
          { email, isActive: false, verification },
          { isActive: true, verification: "", verificationExpires: 0 }
        );
      } else {
        return new RpcException({
          key: "USER_NOT_FOUND",
          code: UserErrorCodes.USER_NOT_FOUND.code,
          message: UserErrorCodes.USER_NOT_FOUND.value
        });
      }
    } catch (e) {
      console.log(e.stack);
      if (e instanceof RpcException) {
        return new RpcException(e);
      }
    }
  }

  async login({
    ip,
    userAgent,
    fingerprint,
    loginUserDto
  }: IpAgentFingerprint & {
    loginUserDto: { rememberMe: boolean } & LoginByEmailDto & LoginByUsernameDto & LoginByPhoneNumberDto;
  }): Promise<HttpStatus | (JWTTokens & UserData) | RpcException> {
    const error: Partial<(UserLoginEmailError & UserLoginUsernameError & UserLoginPhoneNumberError) & InternalFailure> = {};
    let user;

    try {
      const sessionData = {
        ip,
        userAgent,
        fingerprint,
        expiresIn: Date.now() + ms(loginUserDto.rememberMe ? process.env.JWT_EXPIRATION_TIME_LONG : process.env.JWT_EXPIRATION_TIME),
        createdAt: Date.now()
      };

      if (loginUserDto.username) {
        user = await this.userModel.findOne({ username: loginUserDto.username });
        if (!user) {
          error.username = ValidationErrorCodes.INVALID_USERNAME.value;
        }
      } else if (loginUserDto.phoneNumber) {
        user = await this.userModel.findOne({ phoneNumber: loginUserDto.phoneNumber });
        if (!user) {
          error.username = ValidationErrorCodes.INVALID_TEL_NUM.value;
        }
      } else if (loginUserDto.email) {
        user = await this.userModel.findOne({ email: loginUserDto.email });
        if (!user) {
          error.email = ValidationErrorCodes.INVALID_EMAIL.value;
        }
      }

      if (!this._isEmpty(error)) {
        return new RpcException(error);
      }

      if (!!user) {
        if (!user.isActive) {
          error.internalFailure = UserErrorCodes.NOT_ACTIVE.value;
        }

        if (user.isActive && user.isBlocked) {
          return new RpcException({
            key: "USER_HAS_BEEN_BLOCKED",
            code: UserErrorCodes.USER_HAS_BEEN_BLOCKED.code,
            message: UserErrorCodes.USER_HAS_BEEN_BLOCKED.value
          });
        }

        if (user.isActive && user.blockExpires !== 0 && user.blockExpires < Date.now()) {
          user.isBlocked = false;
          user.blockExpires = 0;
          user.save();
        }

        const { salt } = await this.vaultModel.findOne({ user: user._id });

        if (!(await argon2.verify(user.password, salt + loginUserDto.password))) {
          user.loginAttempts += 1;
          await user.save();
          if (user.loginAttempts >= process.env.LOGIN_ATTEMPTS_TO_BLOCK) {
            user.blockExpires = new Date(Date.now() + ms(process.env.HOURS_TO_BLOCK));
            user.isBlocked = true;
            user.loginAttempts = 0;
            await user.save();
            return new RpcException({
              key: "USER_HAS_BEEN_BLOCKED",
              code: UserErrorCodes.USER_HAS_BEEN_BLOCKED.code,
              message: `You are blocked for ${process.env.HOURS_TO_BLOCK.toUpperCase()}.`
            });
          }
          error.password = ValidationErrorCodes.INVALID_PASSWORD.value;
        }

        if (!this._isEmpty(error)) {
          return new RpcException(error);
        }

        const { accessToken, refreshToken } = await this.authService.generateJWT(user._id, sessionData);

        if (accessToken && refreshToken) {
          user.loginAttempts = 0;
          user.save();

          const userData = {
            _id: user._id,
            email: user.email,
            username: user.username,
            phoneNumber: user.phoneNumber,
            firstName: user.firstName,
            lastName: user.lastName,
            birthday: user.birthday,
            photo: user.photo
          };

          return {
            user: userData,
            accessToken,
            refreshToken
          };
        } else {
          return HttpStatus.BAD_REQUEST;
        }
      }
      return HttpStatus.BAD_REQUEST;
    } catch (e) {
      console.log(e.stack);
      if (e instanceof RpcException) {
        return new RpcException(e);
      }
    }
  }

  async logout({ userId, ip, userAgent, fingerprint, refreshToken }: RequestInfo): Promise<HttpStatus | Observable<any> | RpcException> {
    try {
      await this.authService.logout({ userId, ip, userAgent, fingerprint, refreshToken });
      return HttpStatus.OK;
    } catch (e) {
      console.log(e.stack);
      if (e instanceof RpcException) {
        return new RpcException(e);
      }
    }
  }

  async changeEmail({
    userId,
    changeEmailDto,
    ip,
    userAgent,
    fingerprint
  }: IpAgentFingerprint & {
    userId: string;
    changeEmailDto: ChangeEmailDto;
  }): Promise<HttpStatus | Observable<any> | RpcException> {
    const error: Partial<EmailChangeError> = {};

    try {
      const emailMatches = await this._isExistingEmail(changeEmailDto.oldEmail);

      if (!emailMatches) {
        error.oldEmail = ValidationErrorCodes.OLD_EMAIL_DOES_NOT_MATCH.value;
      }
      if (await this._isExistingEmail(changeEmailDto.newEmail)) {
        error.newEmail = ValidationErrorCodes.EMAIL_ALREADY_EXISTS.value;
      }
      if (!this._isEmpty(error)) {
        return new RpcException(error);
      }

      const userRecord = await this.userModel.findOne({ _id: userId, isActive: true });
      const userChangeRequests = await this.changePrimaryDataDocumentModel.countDocuments({
        user: Types.ObjectId(userId),
        verified: false
      });

      if (userRecord.isBlocked || userChangeRequests !== 0) {
        return new RpcException({
          key: "USER_HAS_BEEN_BLOCKED",
          code: UserErrorCodes.USER_HAS_BEEN_BLOCKED.code,
          message: `${UserErrorCodes.USER_HAS_BEEN_BLOCKED.value} You must verify previous data change. Check your email.`
        });
      }

      const verification = v4();

      await this.userModel.updateOne(
        { _id: Types.ObjectId(userId), email: changeEmailDto.oldEmail, isActive: true },
        {
          email: changeEmailDto.newEmail,
          isBlocked: true,
          verificationExpires: Date.now() + ms(process.env.HOURS_TO_VERIFY),
          blockExpires: Date.now() + ms(process.env.HOURS_TO_VERIFY),
          verification
        }
      );

      const changePrimaryDataRequest = new this.changePrimaryDataDocumentModel({
        user: Types.ObjectId(userId),
        verification,
        expires: ms(process.env.HOURS_TO_VERIFY),
        ipOfRequest: ip,
        browserOfRequest: userAgent,
        fingerprintOfRequest: fingerprint,
        dataType: "email",
        verified: false
      });

      await changePrimaryDataRequest.save();

      return await this.client.send(
        { cmd: "verify" },
        { verificationCode: verification, email: changeEmailDto.newEmail, mailType: "VERIFY_EMAIL_CHANGE" }
      );
    } catch (e) {
      console.log(e.stack);
      if (e instanceof RpcException) {
        return new RpcException(e);
      }
    }
  }

  async changeUsername({
    userId,
    changeUsernameDto,
    ip,
    userAgent,
    fingerprint
  }: IpAgentFingerprint & {
    userId: string;
    changeUsernameDto: ChangeUsernameDto;
  }): Promise<HttpStatus | Observable<any> | RpcException> {
    const error: Partial<UsernameChangeError> = {};
    try {
      const usernameMatches = await this._isExistingUsername(changeUsernameDto.oldUsername);

      if (!usernameMatches) {
        error.oldUsername = ValidationErrorCodes.OLD_USERNAME_DOES_NOT_MATCH.value;
      }
      if (await this._isExistingUsername(changeUsernameDto.newUsername)) {
        error.newUsername = ValidationErrorCodes.USERNAME_ALREADY_EXISTS.value;
      }
      if (!this._isEmpty(error)) {
        return new RpcException(error);
      }

      const user = await this.userModel.findOne({ _id: Types.ObjectId(userId), isActive: true });
      const userChangeRequests = await this.changePrimaryDataDocumentModel.countDocuments({
        user: Types.ObjectId(userId),
        verified: false
      });

      if (user.isBlocked || userChangeRequests !== 0) {
        return new RpcException({
          key: "USER_HAS_BEEN_BLOCKED",
          code: UserErrorCodes.USER_HAS_BEEN_BLOCKED.code,
          message: `${UserErrorCodes.USER_HAS_BEEN_BLOCKED.value} You must verify previous data change. Check your email.`
        });
      }

      const verification = v4();

      const changePrimaryDataRequest = new this.changePrimaryDataDocumentModel({
        user: Types.ObjectId(userId),
        verification,
        expires: ms(process.env.HOURS_TO_VERIFY),
        ipOfRequest: ip,
        browserOfRequest: userAgent,
        fingerprintOfRequest: fingerprint,
        dataType: "username",
        verified: false
      });

      await changePrimaryDataRequest.save();

      await this.userModel.updateOne(
        { _id: userId, username: changeUsernameDto.oldUsername, isActive: true },
        {
          username: changeUsernameDto.newUsername,
          isBlocked: true,
          verificationExpires: Date.now() + ms(process.env.HOURS_TO_VERIFY),
          blockExpires: Date.now() + ms(process.env.HOURS_TO_VERIFY),
          verification
        }
      );

      return await this.client.send(
        { cmd: "verify" },
        { verificationCode: verification, email: user.email, mailType: "VERIFY_USERNAME_CHANGE" }
      );
    } catch (e) {
      console.log(e.stack);
      if (e instanceof RpcException) {
        return new RpcException(e);
      }
    }
  }

  async changePhoneNumber({
    userId,
    changePhoneNumberDto,
    ip,
    userAgent,
    fingerprint
  }: IpAgentFingerprint & {
    userId: string;
    changePhoneNumberDto: ChangePhoneNumberDto;
  }): Promise<HttpStatus | Observable<any> | RpcException> {
    const error: Partial<PhoneChangeError> = {};

    try {
      const phoneMatches = await this._isExistingPhone(changePhoneNumberDto.oldPhoneNumber);

      if (!phoneMatches) {
        error.oldPhoneNumber = ValidationErrorCodes.OLD_TEL_NUM_DOES_NOT_MATCH.value;
      }
      if (await this._isExistingEmail(changePhoneNumberDto.newPhoneNumber)) {
        error.newPhoneNumber = ValidationErrorCodes.TEL_NUM_ALREADY_EXISTS.value;
      }
      if (!this._isEmpty(error)) {
        return new RpcException(error);
      }

      const user = await this.userModel.findOne({ _id: userId, isActive: true });
      const userChangeRequests = await this.changePrimaryDataDocumentModel.countDocuments({ userId, verified: false });

      if (user.isBlocked || userChangeRequests !== 0) {
        return new RpcException({
          key: "USER_HAS_BEEN_BLOCKED",
          code: UserErrorCodes.USER_HAS_BEEN_BLOCKED.code,
          message: `${UserErrorCodes.USER_HAS_BEEN_BLOCKED.value} You must verify previous data change. Check your email.`
        });
      }

      const verification = v4();

      await this.userModel.updateOne(
        { _id: userId, phoneNumber: changePhoneNumberDto.oldPhoneNumber, isActive: true },
        {
          phoneNumber: changePhoneNumberDto.newPhoneNumber,
          isBlocked: true,
          verificationExpires: Date.now() + ms(process.env.HOURS_TO_VERIFY),
          blockExpires: Date.now() + ms(process.env.HOURS_TO_VERIFY),
          verification
        }
      );

      const changePrimaryDataRequest = new this.changePrimaryDataDocumentModel({
        user: Types.ObjectId(userId),
        verification,
        expires: ms(process.env.HOURS_TO_VERIFY),
        ipOfRequest: ip,
        browserOfRequest: userAgent,
        fingerprintOfRequest: fingerprint,
        dataType: "phone",
        verified: false
      });

      await changePrimaryDataRequest.save();

      return await this.client.send(
        { cmd: "verify" },
        { verificationCode: verification, email: user.email, mailType: "VERIFY_PHONE_CHANGE" }
      );
    } catch (e) {
      console.log(e.stack);
      if (e instanceof RpcException) {
        return new RpcException(e);
      }
    }
  }

  async changePassword({
    userId,
    changePasswordDto,
    ip,
    userAgent,
    fingerprint
  }: IpAgentFingerprint & {
    userId: string;
    changePasswordDto: ChangePasswordDto;
  }): Promise<HttpStatus | Observable<any> | RpcException> {
    const error: Partial<PasswordChangeError> = {};

    try {
      const user = await this.userModel.findOne({ _id: userId, isActive: true });
      const { salt: oldSalt } = await this.vaultModel.findOne({ userId });

      if (!(await argon2.verify(user.password, oldSalt + changePasswordDto.oldPassword))) {
        error.oldPassword = ValidationErrorCodes.OLD_PASSWORD_DOES_NOT_MATCH.value;
      } else if (!(await this._validatePasswordUniqueness(changePasswordDto.newPassword))) {
        error.newPassword = ValidationErrorCodes.INVALID_PASSWORD.value;
      }
      if (!this._isEmpty(error)) {
        return new RpcException(error);
      }

      const userChangeRequests = await this.changePrimaryDataDocumentModel.countDocuments({ userId, verified: false });

      if (user.isBlocked || userChangeRequests !== 0) {
        return new RpcException({
          key: "USER_HAS_BEEN_BLOCKED",
          code: UserErrorCodes.USER_HAS_BEEN_BLOCKED.code,
          message: `${UserErrorCodes.USER_HAS_BEEN_BLOCKED.value} You must verify previous data change. Check your email.`
        });
      }

      const salt = crypto.randomBytes(10).toString("hex");
      const verification = v4();
      changePasswordDto.newPassword = await this._generatePassword(changePasswordDto.newPassword, salt);
      await this.userModel.updateOne(
        { _id: userId },
        {
          password: changePasswordDto.newPassword,
          isBlocked: true,
          verificationExpires: Date.now() + ms(process.env.HOURS_TO_VERIFY),
          blockExpires: Date.now() + ms(process.env.HOURS_TO_VERIFY),
          verification
        }
      );
      await this.vaultModel.updateOne({ userId }, { salt });

      const changePrimaryDataRequest = new this.changePrimaryDataDocumentModel({
        user: userId,
        verification,
        expires: ms(process.env.HOURS_TO_VERIFY),
        ipOfRequest: ip,
        browserOfRequest: userAgent,
        fingerprintOfRequest: fingerprint,
        dataType: "password",
        verified: false
      });

      await changePrimaryDataRequest.save();

      return await this.client.send(
        { cmd: "verify" },
        { verificationCode: verification, email: user.email, mailType: "VERIFY_PASSWORD_CHANGE" }
      );
    } catch (e) {
      console.log(e.stack);
      if (e instanceof RpcException) {
        return new RpcException(e);
      }
    }
  }

  async verifyPrimaryDataChange({
    userId,
    verification,
    dataType
  }: {
    userId: string;
    verification: string;
    dataType: "email" | "password" | "username" | "phone";
  }): Promise<HttpStatus | UserData | Observable<any> | RpcException> {
    try {
      const primaryDataChangeRequestExists = await this.changePrimaryDataDocumentModel.exists({
        userId,
        verification,
        dataType,
        verified: false
      });

      if (primaryDataChangeRequestExists) {
        await this.userModel.updateOne({ userId }, { isBlocked: false, verification: "", verificationExpires: 0, blockExpires: 0 });
        await this.changePrimaryDataDocumentModel.updateOne(
          {
            userId,
            verification,
            dataType
          },
          { verified: true }
        );

        const user = await this.userModel.findOne({ _id: userId, isActive: true });

        return {
          user: {
            _id: user._id,
            email: user.email,
            username: user.username,
            phoneNumber: user.phoneNumber,
            firstName: user.firstName,
            lastName: user.lastName,
            birthday: user.birthday,
            photo: user.photo
          }
        };
      } else {
        return HttpStatus.BAD_REQUEST;
      }
    } catch (e) {
      console.log(e.stack);
      if (e instanceof RpcException) {
        return new RpcException(e);
      }
    }
  }

  async addOrChangeOptionalData({
    userId,
    optionalDataDto
  }: {
    userId: string;
    optionalDataDto: AddOrUpdateOptionalDataDto;
  }): Promise<HttpStatus | UserData | Observable<any> | RpcException> {
    try {
      const user = await this.userModel.findOne({ _id: userId, isActive: true });

      await this.userModel.updateOne(
        { _id: userId },
        {
          firstName: optionalDataDto.hasOwnProperty("firstName") ? optionalDataDto.firstName : user.firstName,
          lastName: optionalDataDto.hasOwnProperty("lastName") ? optionalDataDto.lastName : user.lastName,
          birthday: optionalDataDto.hasOwnProperty("birthday") ? optionalDataDto.birthday : user.birthday
        }
      );

      const userData = await this.userModel.findOne({ _id: userId });

      return {
        user: {
          _id: userData._id,
          email: userData.email,
          username: userData.username,
          phoneNumber: userData.phoneNumber,
          firstName: userData.firstName,
          lastName: userData.lastName,
          birthday: userData.birthday,
          photo: userData.photo
        }
      };
    } catch (e) {
      console.log(e.stack);
      if (e instanceof RpcException) {
        return new RpcException(e);
      }
    }
  }

  async changePhoto({ userId, photo }: { userId: string; photo: any }): Promise<HttpStatus | UserData | Observable<any> | RpcException> {
    try {
      cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET,
        secure: true
      });

      const user = await this.userModel.findOne({ _id: userId, isActive: true });

      const result = await cloudinary.uploader.upload(photo.photo, {
        overwrite: true,
        invalidate: true,
        folder: `ChatiZZe/${user._id}/`,
        public_id: `profile_pic`
      });

      await this.userModel.updateOne(
        { _id: userId },
        {
          photo: result ? result.secure_url : user.photo
        }
      );

      return {
        user: {
          _id: user._id,
          email: user.email,
          username: user.username,
          phoneNumber: user.phoneNumber,
          firstName: user.firstName,
          lastName: user.lastName,
          birthday: user.birthday,
          photo: result ? result.secure_url : user.photo
        }
      };
    } catch (e) {
      console.log(e.stack);
      if (e instanceof RpcException) {
        return new RpcException(e);
      }
    }
  }

  async refreshSession({ ip, userAgent, fingerprint, refreshToken, userId }: RequestInfo): Promise<HttpStatus | JWTTokens> {
    const sessionData = {
      ip,
      userAgent,
      fingerprint,
      expiresIn: Date.now() + ms(process.env.JWT_REFRESH_EXPIRATION_TIME),
      createdAt: Date.now()
    };

    this.authService
      .refreshSession(
        {
          refreshToken,
          userId
        },
        sessionData
      )
      .then((tokens) => {
        const { accessToken, refreshToken } = tokens;

        return {
          accessToken,
          refreshToken
        };
      })
      .catch((e) => {
        console.log(e);
        if (e instanceof RpcException) {
          return new RpcException(e);
        }
      });

    return HttpStatus.BAD_REQUEST;
  }

  async restPassword({
    ip,
    userAgent,
    fingerprint,
    forgotPasswordDto
  }: IpAgentFingerprint & {
    forgotPasswordDto: ForgotPasswordDto;
  }): Promise<HttpStatus | Observable<any> | RpcException> {
    const userExists = await this.userModel.exists({ email: forgotPasswordDto.email, isActive: true });
    try {
      if (userExists) {
        const forgotPassword = await this.forgotPasswordModel.create({
          email: forgotPasswordDto.email,
          verification: v4(),
          expires: Date.now() + ms(process.env.HOURS_TO_VERIFY),
          ipOfRequest: ip,
          browserOfRequest: userAgent,
          fingerprintOfRequest: fingerprint
        });
        await forgotPassword.save();
        return await this.client.send(
          { cmd: "reset-password" },
          { verificationCode: forgotPassword.verification, email: forgotPassword.email, mailType: "RESET_PASSWORD" }
        );
      } else {
        return HttpStatus.BAD_REQUEST;
      }
    } catch (e) {
      console.log(e.stack);
      if (e instanceof RpcException) {
        return new RpcException(e);
      }
    }
  }

  async verifyPasswordReset({
    email,
    verifyUuidDto
  }: {
    email: string;
    verifyUuidDto: VerifyPasswordResetDto;
  }): Promise<HttpStatus | Observable<any> | RpcException> {
    try {
      const forgotPassword = await this.forgotPasswordModel.exists({
        verification: verifyUuidDto.verification
      });

      if (forgotPassword) {
        if (verifyUuidDto.newPassword === verifyUuidDto.newPasswordVerification) {
          delete verifyUuidDto.newPasswordVerification;

          const user = await this.userModel.findOne({ email });

          const salt = crypto.randomBytes(10).toString("hex");
          const newPassword = await this._generatePassword(verifyUuidDto.newPassword, salt);
          await this.userModel.updateOne({ _id: user._id }, { password: newPassword });
          await this.vaultModel.updateOne({ user: user._id }, { salt });
          return HttpStatus.OK;
        } else {
          return new RpcException({
            key: "PASSWORDS_DOES_NOT_MATCH",
            code: ValidationErrorCodes.PASSWORDS_DOES_NOT_MATCH.code,
            message: ValidationErrorCodes.PASSWORDS_DOES_NOT_MATCH.value
          });
        }
      } else {
        return HttpStatus.BAD_REQUEST;
      }
    } catch (e) {
      console.log(e.stack);
      if (e instanceof RpcException) {
        return new RpcException(e);
      }
    }
  }

  async _findById(userId): Promise<UserDocument | RpcException> {
    try {
      return this.userModel.findOne({ _id: userId });
    } catch (e) {
      console.log(e.stack);
      return new RpcException(e);
    }
  }

  private async _isExistingEmail(email): Promise<boolean | RpcException> {
    try {
      return this.userModel.exists({ email });
    } catch (e) {
      console.log(e.stack);
      return new RpcException(e);
    }
  }

  private async _isExistingUsername(username): Promise<boolean | RpcException> {
    try {
      return this.userModel.exists({ username });
    } catch (e) {
      console.log(e.stack);
      return new RpcException(e);
    }
  }

  private async _isExistingPhone(phoneNumber): Promise<boolean | RpcException> {
    try {
      return this.userModel.exists({ phoneNumber });
    } catch (e) {
      console.log(e.stack);
      return new RpcException(e);
    }
  }

  private async _isExistingPassword(password): Promise<boolean | RpcException> {
    try {
      return this.userModel.exists({ password });
    } catch (e) {
      console.log(e.stack);
      return new RpcException(e);
    }
  }

  private async _validatePasswordUniqueness(password): Promise<boolean | RpcException> {
    try {
      const salt = crypto.randomBytes(10).toString("hex");
      const saltedPassword = await this._generatePassword(password, salt);

      if (this.counter <= Number.parseInt(process.env.MAXIMUM_PASSWORD_VALIDATIONS)) {
        if (await this._isExistingPassword(saltedPassword)) {
          await this._validatePasswordUniqueness(password);
        } else {
          this.counter = 0;
          return true;
        }
      } else {
        this.counter = 0;
        return false;
      }
    } catch (e) {
      console.log(e.stack);
      return new RpcException(e);
    }
  }

  private async _generatePassword(password, salt): Promise<string> {
    try {
      password = salt + password;

      return await argon2.hash(password, {
        hashLength: 40,
        memoryCost: 8192,
        timeCost: 4,
        type: argon2.argon2id
      });
    } catch (e) {
      console.log(e.stack);
    }
  }

  private _isEmpty(obj): boolean | string {
    if (obj) {
      const isString = typeof obj === "string" || obj instanceof String;
      if ((typeof obj === "number" || obj instanceof Number) && obj !== 0) {
        return false;
      }
      return (
        obj === "" ||
        obj === 0 ||
        (Object.keys(obj).length === 0 && obj.constructor === Object) ||
        obj.length === 0 ||
        (isString && obj.trim().length === 0)
      );
    } else {
      return "type is undefined or null";
    }
  }
}
