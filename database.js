const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./attendance.db');

db.serialize(() => {
  // 1. 현장 설정 테이블
  db.run(`CREATE TABLE IF NOT EXISTS sites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    address TEXT,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL
  )`);

  // 2. 근무 패턴 테이블 (is_overnight: 익일 퇴근 여부 0 또는 1)
  db.run(`CREATE TABLE IF NOT EXISTS work_patterns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER,
    pattern_name TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    rest_time INTEGER DEFAULT 0,
    is_overnight INTEGER DEFAULT 0,
    FOREIGN KEY(site_id) REFERENCES sites(id)
  )`);

  // 3. 직원 정보 테이블
  db.run(`CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY,
    password TEXT,
    name TEXT,
    username TEXT UNIQUE,
    department TEXT,
    position TEXT,
    site_id INTEGER,
    role TEXT DEFAULT 'user',
    birth_date TEXT,
    assigned_date TEXT,
    resigned_date TEXT,
    FOREIGN KEY(site_id) REFERENCES sites(id)
  )`);

  // 4. 근무 배정 테이블
  db.run(`CREATE TABLE IF NOT EXISTS employee_schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER,
    pattern_id INTEGER,
    start_date TEXT NOT NULL,
    end_date TEXT,
    type TEXT DEFAULT 'normal',
    status TEXT DEFAULT 'approved',
    extra_start TEXT,
    extra_end TEXT,
    rest_time INTEGER DEFAULT 0,
    rejection_reason TEXT,
    FOREIGN KEY(employee_id) REFERENCES employees(id),
    FOREIGN KEY(pattern_id) REFERENCES work_patterns(id)
  )`);

  // 5. 출퇴근 로그 테이블
  db.run(`CREATE TABLE IF NOT EXISTS attendance_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER,
    site_id INTEGER,
    work_date TEXT,
    check_in_time DATETIME,
    check_out_time DATETIME,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    status TEXT
  )`);

  // 6. DB 마이그레이션
  const columns = [
    "ALTER TABLE employees ADD COLUMN site_id INTEGER",
    "ALTER TABLE employees ADD COLUMN role TEXT DEFAULT 'user'",
    "ALTER TABLE employees ADD COLUMN birth_date TEXT",
    "ALTER TABLE employees ADD COLUMN assigned_date TEXT",
    "ALTER TABLE employees ADD COLUMN resigned_date TEXT",
    "ALTER TABLE employee_schedules ADD COLUMN type TEXT DEFAULT 'normal'",
    "ALTER TABLE employee_schedules ADD COLUMN status TEXT DEFAULT 'approved'",
    "ALTER TABLE employee_schedules ADD COLUMN extra_start TEXT",
    "ALTER TABLE employee_schedules ADD COLUMN extra_end TEXT",
    "ALTER TABLE work_patterns ADD COLUMN rest_time INTEGER DEFAULT 0",
    "ALTER TABLE work_patterns ADD COLUMN is_overnight INTEGER DEFAULT 0",
    "ALTER TABLE employee_schedules ADD COLUMN rest_time INTEGER DEFAULT 0",
    "ALTER TABLE employee_schedules ADD COLUMN rejection_reason TEXT"
  ];
  columns.forEach(sql => db.run(sql, (err) => { /* 존재 시 무시 */ }));

  // 7. 초기 테스트 데이터
  db.run("INSERT OR IGNORE INTO sites (id, name, latitude, longitude) VALUES (1, '한밭대학교(주)삼경엠에스', 37.5665, 126.9780)");
  db.run("INSERT OR IGNORE INTO work_patterns (id, site_id, pattern_name, start_time, end_time, rest_time, is_overnight) VALUES (1, 1, '주간1', '07:00', '18:00', 1, 0)");
  db.run("INSERT OR IGNORE INTO employees (id, username, password, name, role) VALUES (1, 'superadmin', '1234', '최고관리자', 'super_admin')");
});

module.exports = db;