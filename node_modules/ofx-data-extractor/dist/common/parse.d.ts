import { ExtractorConfig } from '../@types/common';
import type { StatementTransaction } from '../@types/ofx/common';
export declare function fixJsonProblems(content: string): string;
export declare const extractFinancialInstitutionTransactionId: (fitid: string) => string;
export declare const isDateField: (field: string) => boolean;
export declare const trim: (str: string) => string;
export declare function objectStartReplacer(param: string, force?: boolean): string;
export declare function objectEndReplacer(param: string, force?: boolean): string;
export declare function configFinancialInstitutionTransactionId({ fitId, fitValue, }: Pick<ExtractorConfig, 'fitId'> & {
    fitValue: string;
}): string;
export declare function sanitizeCurrency(value: string): string;
type GetDateParams = Pick<ExtractorConfig, 'formatDate'> & {
    dateString: string;
};
export declare function getConfiguredDate({ dateString, formatDate: format, }: GetDateParams): string;
export declare function sanitize(row: string, config: ExtractorConfig): string;
export declare function isValidNumberToConvert(field: string, value: string): boolean;
export declare function parseTransactions(content: string): {
    oldListText: string;
    newListText: string;
};
export declare function getBankStatementTransactionsText(ofxContent: string): {
    newBankStatementTransactions: null;
    oldBankStatementTransactions: null;
} | {
    newBankStatementTransactions: string;
    oldBankStatementTransactions: string;
};
export declare function getCreditCardStatementTransactionsText(ofxContent: string): {
    newCreditCardStatementTransactions: null;
    oldCreditCardStatementTransactions: null;
} | {
    newCreditCardStatementTransactions: string;
    oldCreditCardStatementTransactions: string;
};
export declare function extractMetaDataFromXml(data: string[]): string[];
export declare function convertMetaDataToObject(stringList: string[], nativeTypes: boolean): {
    [key: string]: any;
};
export declare function getTransactionsSummary(transations: StatementTransaction[]): {
    credit: number;
    debit: number;
    amountOfCredits: number;
    amountOfDebits: number;
};
export {};
