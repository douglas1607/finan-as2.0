import { OfxStructure } from '../@types/ofx/index';
import { CustomExtractor } from '../interfaces/custom-extractor.interface';
import { Config } from '../common/config';
import { TransactionsSummary } from '../@types/common';
export declare class OfxExtractor extends CustomExtractor {
    setConfig(config: Config): void;
    getBankTransferList(data: string): any;
    getCreditCardTransferList(data: string): any;
    getTransactionsSummary(data: string): TransactionsSummary;
    getContent(data: string): OfxStructure;
}
