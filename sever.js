const express = require('express');
const bodyParser = require('body-parser');
const db = require('./database');
const session = require('express-session');
const app = express();

app.engine('html', require('ejs').renderFile);
app.set('view engine', 'html');
app.use(express.static('views'));
app.use(bodyParser.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: 'attendance-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

const isAuthenticated = (req, res, next) => {
  if (req.session && req.session.user) {
    next();
  } else {
    if (req.originalUrl.startsWith('/api/')) {
      res.status(401).json({ success: false, message: "세션이 만료되었습니다. 다시 로그인하세요." });
    } else {
      res.redirect('/login');
    }
  }
};

app.get('/login', (req, res) => res.render('login'));

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  db.get("SELECT * FROM employees WHERE username = ? AND password = ?", [username, password], (err, user) => {
    if (err) return res.status(500).json({ success: false, message: "DB 오류가 발생했습니다." });
    if (user) {
      req.session.user = { id: user.id, username: user.username, name: user.name, role: user.role, site_id: user.site_id };
      res.json({ success: true, role: user.role });
    } else {
      res.status(401).json({ success: false, message: "아이디 또는 비밀번호가 틀렸습니다." });
    }
  });
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

app.get('/', isAuthenticated, (req, res) => res.render('index'));

app.get('/api/user/me', isAuthenticated, (req, res) => {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  const user = req.session.user;
  const query = `
    SELECT e.name, e.department, e.position, e.role, e.site_id as managed_site_id,
           ms.name as managed_site_name,
           s.name as site_name, s.latitude, s.longitude, wp.start_time, wp.end_time,
           wp.pattern_name, wp.is_overnight,
           al.check_in_time, al.check_out_time, al.status as attendance_status
    FROM employees e
    LEFT JOIN sites ms ON e.site_id = ms.id
    LEFT JOIN employee_schedules es ON e.id = es.employee_id AND ? BETWEEN es.start_date AND IFNULL(es.end_date, '9999-12-31')
    LEFT JOIN work_patterns wp ON es.pattern_id = wp.id
    LEFT JOIN sites s ON wp.site_id = s.id
    LEFT JOIN attendance_logs al ON e.id = al.employee_id AND al.work_date = ?
    WHERE e.id = ?`;

  db.get(query, [today, today, user.id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    const userRow = row || {};
    res.json({
      ...userRow,
      name: userRow.name || user.name,
      role: user.role,
      site_id: user.site_id,
      site_name: userRow.managed_site_name || userRow.site_name
    });
  });
});

app.get('/api/admin/dashboard', isAuthenticated, (req, res) => {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  const user = req.session.user;
  let siteFilter = "";
  let params = [today];

  if (user.role === 'site_admin' || user.role === 'head_admin') {
    if (user.site_id) {
      siteFilter = " AND wp.site_id = ?";
      params.push(user.site_id);
    }
  }

  const query1 = `SELECT COUNT(*) as total FROM employee_schedules es JOIN work_patterns wp ON es.pattern_id = wp.id WHERE ? BETWEEN es.start_date AND IFNULL(es.end_date, '9999-12-31') ${siteFilter}`;

  db.get(query1, params, (err, row) => {
    const stats = { target: row ? row.total : 0 };
    let query2 = 'SELECT COUNT(DISTINCT al.employee_id) as done FROM attendance_logs al WHERE al.work_date = ?';
    let params2 = [today];

    if (user.role === 'site_admin' || user.role === 'head_admin') {
      if (user.site_id) {
        query2 += ' AND al.site_id = ?';
        params2.push(user.site_id);
      }
    }

    db.get(query2, params2, (err, row2) => {
      stats.completed = row2 ? row2.done : 0;
      stats.late = stats.target - stats.completed;
      res.json(stats);
    });
  });
});

app.get('/api/admin/sites', isAuthenticated, (req, res) => {
  const user = req.session.user;
  let query = "SELECT * FROM sites";
  let params = [];

  if ((user.role === 'head_admin' || user.role === 'site_admin') && user.site_id) {
    query += " WHERE id = ?";
    params.push(user.site_id);
  }

  db.all(query, params, (err, sites) => {
    if (err) return res.status(500).json({ error: err.message });
    db.all("SELECT * FROM work_patterns", [], (err, patterns) => {
      if (err) return res.status(500).json({ error: err.message });
      const result = (sites || []).map(s => ({
        ...s,
        patterns: patterns.filter(p => p.site_id === s.id)
      }));
      res.json(result);
    });
  });
});

app.post('/api/admin/sites', isAuthenticated, (req, res) => {
  const user = req.session.user;
  if (user.role !== 'super_admin' && user.role !== 'head_admin') {
    return res.json({ success: false, message: "권한이 없습니다." });
  }

  const { id, name, address, lat, lng, patterns } = req.body;

  const savePatterns = (siteId, callback) => {
    db.run('DELETE FROM work_patterns WHERE site_id = ?', [siteId], (err) => {
      if (err) return callback(err);
      if (!patterns || patterns.length === 0) return callback(null);
      let completed = 0, hasError = false;

      patterns.forEach(p => {
        db.run('INSERT INTO work_patterns (site_id, pattern_name, start_time, end_time, rest_time, is_overnight) VALUES (?, ?, ?, ?, ?, ?)',
          [siteId, p.name, p.start_time, p.end_time, p.rest_time || 0, p.is_overnight ? 1 : 0], (err) => {
            if (hasError) return;
            if (err) { hasError = true; return callback(err); }
            completed++;
            if (completed === patterns.length) callback(null);
          });
      });
    });
  };

  if (id) {
    db.run('UPDATE sites SET name = ?, address = ?, latitude = ?, longitude = ? WHERE id = ?',
      [name, address, lat, lng, id], (err) => {
        if (err) return res.json({ success: false, message: err.message });
        savePatterns(id, (err) => res.json({ success: !err, message: err ? err.message : "" }));
      });
  } else {
    db.run('INSERT INTO sites (name, address, latitude, longitude) VALUES (?, ?, ?, ?)',
      [name, address, lat, lng], function (err) {
        if (err) return res.json({ success: false, message: err.message });
        savePatterns(this.lastID, (err) => res.json({ success: !err, message: err ? err.message : "" }));
      });
  }
});

app.post('/api/admin/sites/delete', isAuthenticated, (req, res) => {
  if (req.session.user.role !== 'super_admin') return res.json({ success: false, message: "최고 관리자만 삭제 가능합니다." });
  const { id } = req.body;
  db.run('DELETE FROM work_patterns WHERE site_id = ?', [id], () => {
    db.run('DELETE FROM sites WHERE id = ?', [id], () => res.json({ success: true }));
  });
});

app.get('/api/admin/users', isAuthenticated, (req, res) => {
  const user = req.session.user;
  let query = "SELECT * FROM employees";
  let params = [];

  if (user.role !== 'super_admin' && user.site_id) {
    query += " WHERE site_id = ? OR id = ?";
    params = [user.site_id, user.id];
  }
  db.all(query, params, (err, rows) => res.json(rows || []));
});

// 근무자 등록 및 권한 설정 API
app.post('/api/admin/users', isAuthenticated, (req, res) => {
  const currentUser = req.session.user;
  if (currentUser.role !== 'super_admin' && currentUser.role !== 'head_admin') {
    return res.json({ success: false, message: "근무자 관리 권한이 없습니다." });
  }

  const { id, username, password, name, department, position, site_id, role, birth_date, assigned_date, resigned_date, isEdit } = req.body;

  if (role === 'super_admin' && currentUser.role !== 'super_admin') {
    return res.json({ success: false, message: "최고 관리자 권한 지정은 최고 관리자만 설정할 수 있습니다." });
  }

  if (isEdit) {
    db.get('SELECT role FROM employees WHERE id = ?', [id], (err, targetUser) => {
      if (targetUser && targetUser.role === 'super_admin' && currentUser.role !== 'super_admin') {
        return res.json({ success: false, message: "최고 관리자의 정보나 권한은 일반 관리자가 수정할 수 없습니다." });
      }

      db.run('UPDATE employees SET username = ?, password = ?, name = ?, department = ?, position = ?, site_id = ?, role = ?, birth_date = ?, assigned_date = ?, resigned_date = ? WHERE id = ?',
        [username, password, name, department, position, site_id, role, birth_date || null, assigned_date || null, resigned_date || null, id], (err) =>
          res.json({ success: !err, message: err ? err.message : "" }));
    });
  } else {
    db.run('INSERT INTO employees (id, username, password, name, department, position, site_id, role, birth_date, assigned_date, resigned_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, username, password, name, department, position, site_id, role, birth_date || null, assigned_date || null, resigned_date || null], (err) =>
        res.json({ success: !err, message: err ? err.message : "" }));
  }
});

// 근무자 삭제 API
app.post('/api/admin/users/delete', isAuthenticated, (req, res) => {
  const currentUser = req.session.user;
  if (currentUser.role !== 'super_admin' && currentUser.role !== 'head_admin') {
    return res.json({ success: false, message: "권한이 없습니다." });
  }

  const targetId = req.body.id;

  db.get('SELECT role FROM employees WHERE id = ?', [targetId], (err, targetUser) => {
    if (targetUser && targetUser.role === 'super_admin' && currentUser.role !== 'super_admin') {
      return res.json({ success: false, message: "최고 관리자 계정은 삭제할 수 없습니다." });
    }
    db.run('DELETE FROM employees WHERE id = ?', [targetId], () => res.json({ success: true }));
  });
});

// [수정 완료] 월간 근무 편성 데이터 조회 API (생년월일, 배치일자, 폐지일자 포함)
app.get('/api/admin/schedules/matrix-monthly', isAuthenticated, (req, res) => {
  const { site_id, year_month } = req.query;
  if (!site_id || !year_month) return res.json({ success: false, message: "파라미터가 부족합니다." });

  db.all("SELECT * FROM work_patterns WHERE site_id = ? ORDER BY id ASC", [site_id], (err, patterns) => {
    if (err) return res.status(500).json({ error: err.message });
    
    const query = `
      SELECT es.*
      FROM employee_schedules es
      JOIN work_patterns wp ON es.pattern_id = wp.id
      WHERE wp.site_id = ? AND es.start_date LIKE ? ;`;

    db.all(query, [site_id, `${year_month}%`], (err, schedules) => {
      if (err) return res.status(500).json({ error: err.message });
      
      // ★ birth_date, assigned_date, resigned_date를 함께 조회하도록 수정 ★
      const empQuery = `
        SELECT id, name, username, department, position, birth_date, assigned_date, resigned_date 
        FROM employees 
        WHERE role NOT IN ('super_admin', 'head_admin') AND (site_id = ? OR site_id IS NULL)
        ORDER BY position ASC, name ASC`;

      db.all(empQuery, [site_id], (err, employees) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ patterns: patterns || [], schedules: schedules || [], employees: employees || [] });
      });
    });
  });
});

// [수정 완료] 월간 근무 편성 일괄 저장 API
app.post('/api/admin/schedules/matrix-save-monthly', isAuthenticated, (req, res) => {
  const user = req.session.user;
  if (user.role === 'worker') return res.json({ success: false, message: "권한이 없습니다." });

  const { site_id, year_month, items } = req.body;
  if (!year_month || !site_id) return res.json({ success: false, message: "파라미터가 부족합니다." });

  const deleteQuery = `
    DELETE FROM employee_schedules 
    WHERE id IN (
      SELECT es.id FROM employee_schedules es
      JOIN work_patterns wp ON es.pattern_id = wp.id
      WHERE wp.site_id = ? AND es.start_date LIKE ?
    )`;

  db.run(deleteQuery, [site_id, `${year_month}%`], (err) => {
    if (err) return res.json({ success: false, message: err.message });
    if (!items || items.length === 0) return res.json({ success: true, message: "스케줄이 저장되었습니다." });

    const validItems = items.filter(i => i.employee_id && i.pattern_id && i.work_date);
    if (validItems.length === 0) return res.json({ success: true, message: "스케줄이 저장되었습니다." });

    let completed = 0, hasError = false;
    validItems.forEach(item => {
      db.run('INSERT INTO employee_schedules (employee_id, pattern_id, start_date, end_date, type, status) VALUES (?, ?, ?, ?, "normal", "approved")',
        [item.employee_id, item.pattern_id, item.work_date, item.work_date], (err) => {
          if (hasError) return;
          if (err) { 
            hasError = true; 
            return res.json({ success: false, message: err.message }); 
          }
          completed++;
          if (completed === validItems.length) {
            res.json({ success: true, message: "월간 스케줄이 성공적으로 저장되었습니다." });
          }
        });
    });
  });
});

app.get('/api/admin/reports/work-status', isAuthenticated, (req, res) => {
  const { site_id, year_month } = req.query;
  if (!site_id || !year_month) return res.json({ success: false, message: "파라미터 부족" });

  db.get("SELECT name FROM sites WHERE id = ?", [site_id], (err, siteRow) => {
    if (err) return res.status(500).json({ error: err.message });
    db.all("SELECT * FROM work_patterns WHERE site_id = ? ORDER BY id ASC", [site_id], (err, patterns) => {
      if (err) return res.status(500).json({ error: err.message });
      
      db.all("SELECT * FROM employees WHERE site_id = ? AND role NOT IN ('super_admin', 'head_admin') ORDER BY position ASC, name ASC", [site_id], (err, employees) => {
        if (err) return res.status(500).json({ error: err.message });

        const querySchedules = `
          SELECT es.*, wp.pattern_name, wp.start_time, wp.end_time, wp.is_overnight
          FROM employee_schedules es
          JOIN work_patterns wp ON es.pattern_id = wp.id
          WHERE wp.site_id = ? AND es.start_date LIKE ?`;

        db.all(querySchedules, [site_id, `${year_month}%`], (err, schedules) => {
          if (err) return res.status(500).json({ error: err.message });

          const queryLogs = 'SELECT * FROM attendance_logs WHERE site_id = ? AND work_date LIKE ?';
          db.all(queryLogs, [site_id, `${year_month}%`], (err, logs) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({
              site_name: siteRow ? siteRow.name : "",
              patterns: patterns || [],
              employees: employees || [],
              schedules: schedules || [],
              attendance_logs: logs || []
            });
          });
        });
      });
    });
  });
});

app.get('/api/admin/attendance/details', isAuthenticated, (req, res) => {
  const { month } = req.query;
  const user = req.session.user;

  let query = `
    SELECT 
      es.start_date as work_date,
      e.id as employee_id,
      e.name as employee_name,
      wp.site_id,
      wp.pattern_name,
      wp.start_time,
      wp.end_time,
      wp.is_overnight,
      al.id as log_id,
      al.check_in_time,
      al.check_out_time,
      al.status as log_status
    FROM employee_schedules es
    JOIN employees e ON es.employee_id = e.id
    JOIN work_patterns wp ON es.pattern_id = wp.id
    LEFT JOIN attendance_logs al ON es.employee_id = al.employee_id AND es.start_date = al.work_date
    WHERE es.start_date LIKE ?`;

  let params = [`${month}%`];

  if (user.role !== 'super_admin' && user.site_id) {
    query += " AND wp.site_id = ?";
    params.push(user.site_id);
  }

  query += " ORDER BY es.start_date DESC, e.name ASC";

  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

app.post('/api/admin/attendance/manual-edit', isAuthenticated, (req, res) => {
  const user = req.session.user;
  if (user.role !== 'super_admin' && user.role !== 'head_admin') {
    return res.json({ success: false, message: "근태 기록 수정 권한이 없습니다. (본사 담당자만 수정 가능)" });
  }
  
  const { log_id, employee_id, site_id, work_date, check_in_time, check_out_time, status_type } = req.body;
  
  const formatDateTime = (dtStr) => {
    if (!dtStr) return null;
    let formatted = dtStr.replace('T', ' ');
    if (formatted.length === 16) {
      formatted += ':00';
    }
    return formatted;
  };

  const inTimeFormatted = formatDateTime(check_in_time);
  const outTimeFormatted = formatDateTime(check_out_time);
  const statusVal = status_type || '정상';

  if (log_id) {
    db.run('UPDATE attendance_logs SET employee_id = ?, site_id = ?, work_date = ?, check_in_time = ?, check_out_time = ?, status = ? WHERE id = ?',
      [employee_id, site_id, work_date, inTimeFormatted, outTimeFormatted, statusVal, log_id], (err) =>
        res.json({ success: !err, message: err ? err.message : "" }));
  } else {
    db.get('SELECT id FROM attendance_logs WHERE employee_id = ? AND work_date = ?', [employee_id, work_date], (err, row) => {
      if (row) {
        db.run('UPDATE attendance_logs SET site_id = ?, check_in_time = ?, check_out_time = ?, status = ? WHERE id = ?',
          [site_id, inTimeFormatted, outTimeFormatted, statusVal, row.id], (err) =>
            res.json({ success: !err, message: err ? err.message : "" }));
      } else {
        db.run('INSERT INTO attendance_logs (employee_id, site_id, work_date, check_in_time, check_out_time, status) VALUES (?, ?, ?, ?, ?, ?)',
          [employee_id, site_id, work_date, inTimeFormatted, outTimeFormatted, statusVal], (err) =>
            res.json({ success: !err, message: err ? err.message : "" }));
      }
    });
  }
});

app.get('/api/user/attendance-logs', isAuthenticated, (req, res) => {
  const { month } = req.query;
  db.all('SELECT * FROM attendance_logs WHERE employee_id = ? AND work_date LIKE ?',
    [req.session.user.id, `${month}%`], (err, rows) => res.json(rows || []));
});

function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

app.post('/api/attendance', isAuthenticated, (req, res) => {
  const { type, lat, lng } = req.body;
  const employee_id = req.session.user.id;
  const now = new Date();
  const work_date = now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });

  if (type === 'in') {
    const query = `
      SELECT s.latitude, s.longitude, s.id as site_id, IFNULL(es.extra_start, wp.start_time) as start_time
      FROM employee_schedules es
      JOIN work_patterns wp ON es.pattern_id = wp.id
      JOIN sites s ON wp.site_id = s.id
      WHERE es.employee_id = ? AND ? BETWEEN es.start_date AND IFNULL(es.end_date, '9999-12-31') AND es.status = 'approved'`;

    db.get(query, [employee_id, work_date], (err, row) => {
      if (err) return res.json({ success: false, message: "DB 조회 오류" });
      if (!row) return res.json({ success: false, message: "오늘 배정된 근무지가 없습니다." });

      const dist = getDistance(lat, lng, row.latitude, row.longitude);
      if (dist > 50) return res.json({ success: false, message: `현장 반경 50m를 벗어났습니다. (현재: ${Math.round(dist)}m)` });

      // const [pStartH, pStartM] = row.start_time.split(':').map(Number);
      // const scheduledStartTime = new Date(now);
      // scheduledStartTime.setHours(pStartH, pStartM, 0, 0);

      // 기존 코드 대체 영역
const [pStartH, pStartM] = row.start_time.split(':').map(Number);

// YYYY-MM-DD HH:mm:ss 형식으로 한국 시간 기준 Date 객체 생성
const scheduledStartTime = new Date(`${work_date}T${String(pStartH).padStart(2, '0')}:${String(pStartM).padStart(2, '0')}:00+09:00`);

// 10분 전 시간 계산
const minAllowedTime = new Date(scheduledStartTime.getTime() - 10 * 60 * 1000);

if (now < minAllowedTime) {
  // 보기 편하게 24시간제(HH:mm) 또는 한국어로 명확히 출력
  const timeStr = minAllowedTime.toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false });
  return res.json({ 
    success: false, 
    message: `출근 가능 시간이 아닙니다. (출근 10분 전인 ${timeStr}부터 등록 가능)` 
  });
}

      // const minAllowedTime = new Date(scheduledStartTime.getTime() - 10 * 60 * 1000);

      if (now < minAllowedTime) {
        return res.json({ 
          success: false, 
          message: `출근 가능 시간이 아닙니다. (출근 10분 전인 ${minAllowedTime.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}부터 등록 가능)` 
        });
      }

      let checkInISO = "";
      let status = "";

      if (now >= minAllowedTime && now <= scheduledStartTime) {
        checkInISO = scheduledStartTime.toISOString();
        status = '출근';
      } else {
        checkInISO = now.toISOString();
        status = '지각';
      }

      // db.get('SELECT id FROM attendance_logs WHERE employee_id = ? AND work_date = ?', [employee_id, work_date], (err, existing) => {
      //   if (existing) {
      //     db.run('UPDATE attendance_logs SET site_id = ?, check_in_time = ?, status = ? WHERE id = ?',
      //       [row.site_id, checkInISO, status, existing.id], () => res.json({ success: true, message: `출근 등록 완료 (${status})` }));
      //   } else {
      //     db.run('INSERT INTO attendance_logs (employee_id, site_id, work_date, check_in_time, status) VALUES (?, ?, ?, ?, ?)',
      //       [employee_id, row.site_id, work_date, checkInISO, status], () => res.json({ success: true, message: `출근 등록 완료 (${status})` }));
      //   }

      //수정
     // 기존에 이미 출근(check_in_time) 기록이 있는지 확인
      db.get('SELECT id, check_in_time FROM attendance_logs WHERE employee_id = ? AND work_date = ?', [employee_id, work_date], (err, existing) => {
        if (err) return res.json({ success: false, message: "DB 조회 오류" });

        // 이미 출근한 기록이 존재하는 경우 연타/재시도 차단
        if (existing && existing.check_in_time) {
          return res.json({ success: false, message: "이미 오늘 출근 등록이 완료되었습니다." });
        }

        // 출근 기록이 없을 때만 신규 등록 (INSERT만 진행)
        db.run('INSERT INTO attendance_logs (employee_id, site_id, work_date, check_in_time, status) VALUES (?, ?, ?, ?, ?)',
          [employee_id, row.site_id, work_date, checkInISO, status], 
          (err) => {
            if (err) return res.json({ success: false, message: "출근 등록 실패" });
            res.json({ success: true, message: `출근 등록 완료 (${status})` });
          }
        );
      });
      //수정끝
      
      });
    });
  } else {
    // 퇴근 처리 영역
    const query = `
      SELECT al.id, al.work_date, al.status, s.latitude, s.longitude, wp.end_time, wp.is_overnight
      FROM attendance_logs al
      JOIN sites s ON al.site_id = s.id
      JOIN employee_schedules es ON al.employee_id = es.employee_id AND al.work_date = es.start_date
      JOIN work_patterns wp ON es.pattern_id = wp.id
      WHERE al.employee_id = ? AND al.check_out_time IS NULL
      ORDER BY al.id DESC LIMIT 1`;

    db.get(query, [employee_id], (err, row) => {
      if (err) return res.json({ success: false, message: "DB 조회 오류" });
      if (!row) return res.json({ success: false, message: "진행 중인 근무 기록이 없습니다." });

      const dist = getDistance(lat, lng, row.latitude, row.longitude);
      if (dist > 50) return res.json({ success: false, message: `현장 반경 50m를 벗어났습니다. (현재: ${Math.round(dist)}m)` });

      const [pEndH, pEndM] = row.end_time.split(':').map(Number);
      
      // ★ 근무 시작일(work_date) 기준으로 날짜 계산 ★
      const scheduledEndTime = new Date(row.work_date + 'T00:00:00');
      if (row.is_overnight) {
        scheduledEndTime.setDate(scheduledEndTime.getDate() + 1); // 익일 퇴근 처리
      }
      scheduledEndTime.setHours(pEndH, pEndM, 0, 0);

      let finalStatus = row.status;
      if (now < scheduledEndTime) {
        finalStatus = '조기퇴근';
      } else {
        finalStatus = (row.status === '지각') ? '지각' : '정상';
      }

    //   db.run('UPDATE attendance_logs SET check_out_time = ?, status = ? WHERE id = ?',
    //     [now.toISOString(), finalStatus, row.id], () => res.json({ success: true, message: `퇴근 등록 완료 (${finalStatus})` }));
    // });

    //수정
      // check_out_time IS NULL 조건을 추가하여 이미 퇴근 처리된 기록은 중복 수정되지 않도록 방어
      db.run('UPDATE attendance_logs SET check_out_time = ?, status = ? WHERE id = ? AND check_out_time IS NULL',
        [now.toISOString(), finalStatus, row.id], 
        function (err) {
          if (err || this.changes === 0) {
            return res.json({ success: false, message: "이미 퇴근 처리되었거나 퇴근 등록에 실패했습니다." });
          }
          res.json({ success: true, message: `퇴근 등록 완료 (${finalStatus})` });
        }
      );
    //수정끝
      
  }
});

app.use((req, res) => res.redirect('/'));
app.listen(3000, () => console.log('Server running on http://localhost:3000'));
