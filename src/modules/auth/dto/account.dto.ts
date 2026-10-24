import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { MaxCodePoints } from '../../../common/validation/max-code-points';
import { NoNulCharacter } from '../../../common/validation/no-nul-character';
import { ACCOUNT_NAME_MAX_LENGTH } from '../entities/account.entity';

export class CreateAccountDto {
  @ApiProperty({
    description: 'Display name of the account (tenant)',
    minLength: 2,
    maxLength: ACCOUNT_NAME_MAX_LENGTH,
    example: 'Toko A',
  })
  @IsString()
  @MinLength(2)
  @MaxLength(ACCOUNT_NAME_MAX_LENGTH)
  @NoNulCharacter()
  name!: string;

  @ApiPropertyOptional({ description: 'Free-form note about who this account is for', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @NoNulCharacter()
  note?: string;

  @ApiPropertyOptional({ description: 'Whether the account may be used', default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateAccountDto {
  @ApiPropertyOptional({ description: 'New display name', minLength: 2, maxLength: ACCOUNT_NAME_MAX_LENGTH })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(ACCOUNT_NAME_MAX_LENGTH)
  @NoNulCharacter()
  name?: string;

  @ApiPropertyOptional({ description: 'Free-form note', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @NoNulCharacter()
  note?: string;

  @ApiPropertyOptional({ description: 'Whether the account may be used' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class AccountResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiPropertyOptional({ nullable: true })
  note?: string | null;

  @ApiProperty()
  isActive!: boolean;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;
}
