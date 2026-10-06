// Keep image extraction and category retries on the same tested local model.
export const receiptModel='qwen3.5:4b';
export const localModelSettings=Object.freeze({model:receiptModel,think:false,stream:false,keep_alive:'5m'});
