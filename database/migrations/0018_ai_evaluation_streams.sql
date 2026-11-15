-- E38-E43 (+ staged rollout for E48-E50): evaluation data, qualification and AI review streams.
INSERT INTO lde_competition.operation_streams VALUES
('evaluation-data','event.manage','write'),('evaluation-data','participant.self','write'),('evaluation-data','result.verify','write'),('evaluation-data','dispute.review','write'),('evaluation-data','result.verify','read'),
('qualification','result.verify','write'),('qualification','dispute.review','write'),('qualification','event.read','read'),
('ai-review','result.verify','write'),('ai-review','scorecard.write-own','write'),('ai-review','result.verify','read');
