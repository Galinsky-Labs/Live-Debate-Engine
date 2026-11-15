-- E13-E19: live event operation streams. Each (stream, action) pair is an explicit grant.
INSERT INTO lde_competition.operation_streams VALUES
('live','event.manage','write'),('live','session.control','write'),('live','result.publish','write'),('live','event.read','read'),
('floor','timer.control','write'),('floor','floor.participate','write'),('floor','session.control','write'),('floor','event.read','read'),
('media','media.control','write'),('media','event.manage','read'),
('recording','media.control','write'),('recording','participant.self','write'),('recording','event.read','read'),
('transcript','event.manage','write'),('transcript','event.read','read'),
('questions','question.submit','write'),('questions','question.moderate','write'),('questions','question.moderate','read');
