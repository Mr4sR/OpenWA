import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { MaxCodePoints } from '../../../common/validation/max-code-points';
import { NoNulCharacter } from '../../../common/validation/no-nul-character';
import { USER_EMAIL_MAX_LENGTH, USER_NAME_MAX_LENGTH } from '../entities/user.entity';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../password-hash';

export class RegisterDto {
  @ApiProperty({ example: 'owner@shop.id', maxLength: USER_EMAIL_MAX_LENGTH })
  @IsEmail({}, { message: 'A valid email address is required' })
  @MaxLength(USER_EMAIL_MAX_LENGTH)
  @NoNulCharacter()
  email!: string;

  @ApiProperty({ minLength: PASSWORD_MIN_LENGTH, maxLength: PASSWORD_MAX_LENGTH })
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH, { message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters` })
  @MaxLength(PASSWORD_MAX_LENGTH)
  @NoNulCharacter()
  password!: string;

  @ApiPropertyOptional({ maxLength: USER_NAME_MAX_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(USER_NAME_MAX_LENGTH)
  @NoNulCharacter()
  name?: string;
}

export class LoginDto {
  @ApiProperty({ example: 'owner@shop.id' })
  @IsString()
  @MaxLength(USER_EMAIL_MAX_LENGTH)
  @NoNulCharacter()
  email!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(PASSWORD_MAX_LENGTH)
  @NoNulCharacter()
  password!: string;
}

export class ChangePasswordDto {
  @ApiProperty()
  @IsString()
  @MaxLength(PASSWORD_MAX_LENGTH)
  @NoNulCharacter()
  currentPassword!: string;

  @ApiProperty({ minLength: PASSWORD_MIN_LENGTH, maxLength: PASSWORD_MAX_LENGTH })
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  @NoNulCharacter()
  newPassword!: string;
}
