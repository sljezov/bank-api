export interface ErrorResponse {
  code: string;
  message: string;
}

export interface UserRegistrationRequest {
  fullName: string;
  email?: string;
}

export interface UserRegistrationResponse {
  userId: string;
  fullName: string;
  email?: string;
  createdAt: string;
  token: string; // bearer token for this user
}

export interface AccountCreationRequest {
  currency: string;
}

export interface AccountCreationResponse {
  accountNumber: string;
  ownerId: string;
  currency: string;
  balance: string;
  createdAt: string;
}

export interface AccountLookupResponse {
  accountNumber: string;
  ownerName: string;
  currency: string;
}

export interface TransferRequest {
  transferId: string;
  sourceAccount: string;
  destinationAccount: string;
  amount: string;
}

export interface TransferResponse {
  transferId: string;
  status: 'completed' | 'failed' | 'pending' | 'failed_timeout';
  sourceAccount: string;
  destinationAccount: string;
  amount: string;
  convertedAmount?: string;
  exchangeRate?: string;
  rateCapturedAt?: string;
  timestamp: string;
  errorMessage?: string;
}

export interface TransferStatusResponse extends TransferResponse {
  pendingSince?: string;
  nextRetryAt?: string;
  retryCount?: number;
}

export interface InterBankTransferRequest {
  jwt: string;
}

export interface InterBankTransferResponse {
  transferId: string;
  status: 'completed' | 'failed';
  destinationAccount: string;
  amount: string;
  timestamp: string;
}

export interface BankInfo {
  bankId: string;
  name: string;
  address: string;
  publicKey: string;
}

export interface ExchangeRates {
  baseCurrency: string;
  rates: Record<string, string>;
  timestamp: string;
}
