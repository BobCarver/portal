-- Categories: gender, age and amateur/professional level (src/eligibility.ts).
-- The profile belongs to the person (a user account); a competition states what
-- it takes. Nullable profile fields mean "not set yet": a person cannot enter
-- until they are set. Existing competitions become open to anyone, with no age
-- limit, so older data keeps working until an organiser sets their rules.

ALTER TABLE users ADD COLUMN gender TEXT
  CHECK (gender IN ('male', 'female'));
ALTER TABLE users ADD COLUMN date_of_birth DATE
  CHECK (date_of_birth IS NULL OR date_of_birth BETWEEN DATE '1900-01-01' AND CURRENT_DATE);
ALTER TABLE users ADD COLUMN level TEXT
  CHECK (level IN ('amateur', 'professional'));

-- The date ages are worked out on (the festival's start, set by the organiser).
ALTER TABLE festivals ADD COLUMN age_on DATE;

ALTER TABLE competitions ADD COLUMN gender TEXT NOT NULL DEFAULT 'open'
  CHECK (gender IN ('male', 'female', 'mixed', 'same_gender', 'open'));
ALTER TABLE competitions ADD COLUMN level TEXT NOT NULL DEFAULT 'open'
  CHECK (level IN ('amateur', 'professional', 'pro_am', 'open'));
ALTER TABLE competitions ADD COLUMN min_age INT CHECK (min_age IS NULL OR min_age >= 0);
ALTER TABLE competitions ADD COLUMN max_age INT CHECK (max_age IS NULL OR max_age >= 0);
ALTER TABLE competitions ADD CONSTRAINT competitions_age_band
  CHECK (min_age IS NULL OR max_age IS NULL OR min_age <= max_age);
