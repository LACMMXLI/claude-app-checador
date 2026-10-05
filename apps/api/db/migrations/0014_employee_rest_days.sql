-- 0014 · D-92: día(s) de descanso semanales y fecha de nacimiento del empleado.
--
--  * `rest_days`: días de la semana ISO (1 = lunes … 7 = domingo) en los que el empleado descansa normalmente. Sin
--    repetidos, solo valores 1..7 y nunca los 7 (alguien que nunca trabaja no se programa). Vacío = sin día fijo.
--    Es una guía de planeación: NO impide programar un turno ni genera faltas (la FALTA nace solo de un turno, D-44).
--  * `birth_date`: opcional; la edad se calcula (nunca se guarda). No puede ser futura ni anterior a 1900.
-- Migración incremental: no modifica ninguna anterior. RLS y permisos de la tabla no cambian (columnas nuevas).
CREATE FUNCTION core.rest_days_valid(p_days smallint[]) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$
  SELECT p_days IS NOT NULL
     AND cardinality(p_days) <= 6
     AND p_days <@ ARRAY[1, 2, 3, 4, 5, 6, 7]::smallint[]
     AND cardinality(p_days) = (SELECT count(DISTINCT d) FROM unnest(p_days) AS d)
$$;

ALTER TABLE core.employees
  ADD COLUMN rest_days  smallint[] NOT NULL DEFAULT '{}' CONSTRAINT employees_rest_days_valid CHECK (core.rest_days_valid(rest_days)),
  ADD COLUMN birth_date date;

-- La fecha de nacimiento depende de la fecha actual: va en un trigger (un CHECK debe ser inmutable).
CREATE FUNCTION core.check_employee_birth_date() RETURNS trigger
LANGUAGE plpgsql AS
$$
BEGIN
  IF NEW.birth_date IS NOT NULL AND (NEW.birth_date < DATE '1900-01-01' OR NEW.birth_date > current_date) THEN
    RAISE EXCEPTION 'INVALID_BIRTH_DATE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER employees_birth_date BEFORE INSERT OR UPDATE OF birth_date ON core.employees
  FOR EACH ROW EXECUTE FUNCTION core.check_employee_birth_date();
