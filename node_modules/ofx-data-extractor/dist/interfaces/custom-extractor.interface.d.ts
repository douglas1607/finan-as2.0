import { Config } from '../common/config';
import { TransactionsSummary } from '../@types/common';
export declare abstract class CustomExtractor {
    configInstance: Config;
    abstract setConfig(config: Config): void;
    abstract getBankTransferList(data: string): any;
    abstract getCreditCardTransferList(data: string): any;
    abstract getTransactionsSummary(data: string): TransactionsSummary;
    abstract getContent(data: string): object;
}
