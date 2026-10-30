import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDb, loadRootEnv } from '@esaf/db'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

loadRootEnv()
const url = process.env.TEST_DATABASE_URL
if (!url && process.env.CI) throw new Error('TEST_DATABASE_URL må være satt i CI.')

const migrations = fileURLToPath(new URL('../../db/drizzle', import.meta.url))

/**
 * Migrering 0019 gjør ESAF-helgene om til arrangementer. Testen lager en egen
 * database, kjører migreringene til og med 0018, legger inn helger og oppmøte
 * slik de lå før, og kjører resten.
 */
describe.skipIf(!url)('migrering 0019: ESAF-helgen blir arrangementer', () => {
  const name = `esaf_migr_${process.pid}_${Date.now()}`
  const scratch = new URL(url!)
  scratch.pathname = `/${name}`
  const admin = createDb(url!)
  let dir: string

  beforeAll(async () => {
    await admin.execute(sql.raw(`create database "${name}"`))
    // Migreringene til og med 0018, i en kopi av mappen.
    dir = mkdtempSync(join(tmpdir(), 'esaf-migr-'))
    cpSync(migrations, dir, { recursive: true })
    const journal = JSON.parse(readFileSync(join(dir, 'meta/_journal.json'), 'utf8'))
    journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= 18)
    writeFileSync(join(dir, 'meta/_journal.json'), JSON.stringify(journal))
  })

  afterAll(async () => {
    await admin.execute(sql.raw(`drop database if exists "${name}" with (force)`))
    await admin.close()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('flytter helgene og oppmøtet med samme id-er og sletter de gamle tabellene', async () => {
    const db = createDb(scratch.href)
    // `pool.end()` kan svare før tilkoblingen er helt lukket. Da avbryter
    // `drop database … with (force)` i afterAll den, og feilen fra Postgres
    // (57P01) ville ellers blitt en uhåndtert feil i testkjøringen.
    db.$client.on('error', () => {})
    try {
      await migrate(db, { migrationsFolder: dir })
      const people = await db.execute<{ id: string }>(
        sql`insert into person (full_name, source) values ('Kari Nordmann', 'admin'), ('Ola Hansen', 'admin') returning id`,
      )
      const [kari, ola] = people.rows.map((r) => r.id)
      const weekends = await db.execute<{ id: string }>(
        sql`insert into esaf_weekend (name, start_date, end_date, location, description) values
          ('ESAF-helgen høst 2018', '2018-09-14', '2018-09-16', 'Oppdal', 'Topptur'),
          ('ESAF-helgen vår 2019', '2019-04-05', null, null, null) returning id`,
      )
      const [autumn, spring] = weekends.rows.map((r) => r.id)
      await db.execute(
        sql`insert into esaf_weekend_attendance (weekend_id, person_id, source) values
          (${autumn}, ${kari}, 'self'), (${autumn}, ${ola}, 'import'), (${spring}, ${kari}, 'admin')`,
      )

      await migrate(db, { migrationsFolder: migrations })

      const types = await db.execute(sql`select slug, name, sort_order from event_type`)
      expect(types.rows).toEqual([{ slug: 'esaf-helgen', name: 'ESAF-helgen', sort_order: 0 }])
      const events = await db.execute(
        sql`select e.id, e.name, e.start_date, e.end_date, e.location, e.description, t.slug from event e join event_type t on t.id = e.type_id order by e.start_date`,
      )
      expect(events.rows).toEqual([
        {
          id: autumn,
          name: 'ESAF-helgen høst 2018',
          start_date: '2018-09-14',
          end_date: '2018-09-16',
          location: 'Oppdal',
          description: 'Topptur',
          slug: 'esaf-helgen',
        },
        {
          id: spring,
          name: 'ESAF-helgen vår 2019',
          start_date: '2019-04-05',
          end_date: null,
          location: null,
          description: null,
          slug: 'esaf-helgen',
        },
      ])
      const rows = await db.execute(
        sql`select event_id, person_id, role, source, note from event_participation order by source`,
      )
      expect(rows.rows).toEqual([
        { event_id: autumn, person_id: kari, role: null, source: 'self', note: null },
        { event_id: spring, person_id: kari, role: null, source: 'admin', note: null },
        { event_id: autumn, person_id: ola, role: null, source: 'import', note: null },
      ])
      const left = await db.execute(
        sql`select to_regclass('esaf_weekend') as weekend, to_regclass('esaf_weekend_attendance') as attendance, to_regtype('weekend_attendance_source') as source`,
      )
      expect(left.rows).toEqual([{ weekend: null, attendance: null, source: null }])
    } finally {
      await db.close()
    }
  })
})
