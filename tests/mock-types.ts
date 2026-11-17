// Browser messages and storage fixtures can include arbitrary fields, including
// deliberately invalid data. Keep this flexibility at the harness boundary.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MockData = Record<string, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MockCallback = (...args: any[]) => any;
