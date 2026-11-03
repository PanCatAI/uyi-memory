用户请角色「{{character_name}}」{{verb_text}}。请找出这句话指的是哪些记忆。

用户原话：{{request}}

最近的对话（用来理解“那件事”指什么）：
{{recent}}

候选记忆（只能从这里选）：
{{candidates}}

规则：宁可少选也不要多选无关的。只选和这件事直接相关的。topic 用一句话概括这件事，后面会给用户确认。

只输出 JSON：{"topic": "", "seqs": [], "fact_ids": [], "cache_ids": [], "commit_ids": []}
