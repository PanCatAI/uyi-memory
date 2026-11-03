// Facts matching these are stored as private: usable when the user brings them up, never volunteered.
export const SENSITIVE = /电话|手机号|\d{3}-?\d{4}-?\d{4}|住址|家庭地址|身份证|护照|银行卡|密码|病历|抑郁|癌|怀孕|住院|吃药/;
export const isSensitive = text => SENSITIVE.test(String(text));
