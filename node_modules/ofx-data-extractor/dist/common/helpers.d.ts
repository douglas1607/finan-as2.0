import { Types } from '../@types/common';
import type { StatementTransaction } from '../@types/ofx/common';
export declare const extractType: (content: string) => Types;
export declare function isDebt(transaction: StatementTransaction): boolean;
