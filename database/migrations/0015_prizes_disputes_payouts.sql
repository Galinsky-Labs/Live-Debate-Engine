-- E27-E31: prize ledger, brackets/placements, disputes and payouts as operation streams.
INSERT INTO lde_competition.operation_streams VALUES
('results','prize.manage','read'),
('prizes','prize.manage','write'),('prizes','payout.approve','write'),('prizes','prize.manage','read'),
('bracket','event.manage','write'),('bracket','event.read','read'),
('disputes','event.manage','write'),('disputes','participant.self','write'),('disputes','dispute.review','write'),('disputes','dispute.review','read'),
('payouts','participant.self','write'),('payouts','payout.approve','write'),('payouts','prize.manage','write'),('payouts','prize.manage','read');
