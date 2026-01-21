from flask import Flask, render_template, request, jsonify, send_from_directory
import sqlite3
import os
import json
from datetime import datetime
import base64
import io
from PIL import Image
import re

# OCR功能 - 使用EasyOCR（如果安装）或简单的文本提取
OCR_AVAILABLE = False
reader = None

def init_ocr():
    """懒加载OCR，只在第一次使用时初始化"""
    global OCR_AVAILABLE, reader
    if reader is not None:
        return reader
    
    try:
        import easyocr
        print("正在初始化OCR引擎，首次使用可能需要下载模型，请稍候...")
        reader = easyocr.Reader(['ch_sim', 'en'])  # 中文简体和英文
        OCR_AVAILABLE = True
        print("OCR引擎初始化完成！")
        return reader
    except ImportError:
        OCR_AVAILABLE = False
        print("警告: EasyOCR未安装，OCR功能将不可用。请运行: pip install easyocr")
        return None

app = Flask(__name__, static_folder='static', static_url_path='/static')
app.config['UPLOAD_FOLDER'] = 'uploads'
app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024  # 16MB max file size

# 确保上传目录存在
os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)
os.makedirs('data', exist_ok=True)

# 初始化数据库
def init_db():
    conn = sqlite3.connect('data/substation.db')
    c = conn.cursor()
    
    # 变电站表
    c.execute('''CREATE TABLE IF NOT EXISTS substations
                 (id INTEGER PRIMARY KEY AUTOINCREMENT,
                  name TEXT UNIQUE NOT NULL,
                  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)''')
    
    # 机子信息表
    c.execute('''CREATE TABLE IF NOT EXISTS machines
                 (id INTEGER PRIMARY KEY AUTOINCREMENT,
                  substation_id INTEGER NOT NULL,
                  position_x INTEGER NOT NULL,
                  position_y INTEGER NOT NULL,
                  name TEXT,
                  info TEXT,
                  image_path TEXT,
                  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                  FOREIGN KEY (substation_id) REFERENCES substations(id))''')
    
    conn.commit()
    conn.close()

init_db()

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/substations', methods=['GET'])
def get_substations():
    conn = sqlite3.connect('data/substation.db')
    c = conn.cursor()
    c.execute('SELECT id, name FROM substations ORDER BY name')
    substations = [{'id': row[0], 'name': row[1]} for row in c.fetchall()]
    conn.close()
    return jsonify(substations)

@app.route('/api/substations', methods=['POST'])
def create_substation():
    data = request.json
    name = data.get('name')
    
    if not name:
        return jsonify({'error': '变电站名称不能为空'}), 400
    
    conn = sqlite3.connect('data/substation.db')
    c = conn.cursor()
    try:
        c.execute('INSERT INTO substations (name) VALUES (?)', (name,))
        conn.commit()
        substation_id = c.lastrowid
        conn.close()
        return jsonify({'id': substation_id, 'name': name}), 201
    except sqlite3.IntegrityError:
        conn.close()
        return jsonify({'error': '变电站名称已存在'}), 400

@app.route('/api/substations/<int:substation_id>/machines', methods=['GET'])
def get_machines(substation_id):
    conn = sqlite3.connect('data/substation.db')
    c = conn.cursor()
    c.execute('''SELECT id, position_x, position_y, name, info, image_path 
                 FROM machines WHERE substation_id = ?''', (substation_id,))
    machines = []
    for row in c.fetchall():
        machines.append({
            'id': row[0],
            'position_x': row[1],
            'position_y': row[2],
            'name': row[3] or '',
            'info': row[4] or '',
            'image_path': row[5] or ''
        })
    conn.close()
    return jsonify(machines)

@app.route('/api/machines', methods=['POST'])
def create_or_update_machine():
    data = request.json
    substation_id = data.get('substation_id')
    position_x = data.get('position_x')
    position_y = data.get('position_y')
    name = data.get('name', '')
    info = data.get('info', '')
    image_data = data.get('image')
    
    if substation_id is None or position_x is None or position_y is None:
        return jsonify({'error': '缺少必要参数'}), 400
    
    # 保存图片
    image_path = None
    if image_data:
        # 解码base64图片
        try:
            image_data = image_data.split(',')[1] if ',' in image_data else image_data
            image_bytes = base64.b64decode(image_data)
            filename = f"machine_{substation_id}_{position_x}_{position_y}_{datetime.now().strftime('%Y%m%d%H%M%S')}.jpg"
            image_path = os.path.join(app.config['UPLOAD_FOLDER'], filename)
            with open(image_path, 'wb') as f:
                f.write(image_bytes)
        except Exception as e:
            return jsonify({'error': f'图片保存失败: {str(e)}'}), 500
    
    conn = sqlite3.connect('data/substation.db')
    c = conn.cursor()
    
    # 检查是否已存在
    c.execute('''SELECT id FROM machines 
                 WHERE substation_id = ? AND position_x = ? AND position_y = ?''',
              (substation_id, position_x, position_y))
    existing = c.fetchone()
    
    if existing:
        # 更新
        if image_path:
            c.execute('''UPDATE machines SET name = ?, info = ?, image_path = ?, 
                        updated_at = CURRENT_TIMESTAMP WHERE id = ?''',
                     (name, info, image_path, existing[0]))
        else:
            c.execute('''UPDATE machines SET name = ?, info = ?, 
                        updated_at = CURRENT_TIMESTAMP WHERE id = ?''',
                     (name, info, existing[0]))
        machine_id = existing[0]
    else:
        # 创建
        c.execute('''INSERT INTO machines (substation_id, position_x, position_y, name, info, image_path)
                     VALUES (?, ?, ?, ?, ?, ?)''',
                 (substation_id, position_x, position_y, name, info, image_path))
        machine_id = c.lastrowid
    
    conn.commit()
    conn.close()
    
    return jsonify({
        'id': machine_id,
        'substation_id': substation_id,
        'position_x': position_x,
        'position_y': position_y,
        'name': name,
        'info': info,
        'image_path': image_path
    }), 201

@app.route('/api/machines/<int:machine_id>', methods=['GET'])
def get_machine(machine_id):
    conn = sqlite3.connect('data/substation.db')
    c = conn.cursor()
    c.execute('''SELECT id, substation_id, position_x, position_y, name, info, image_path
                 FROM machines WHERE id = ?''', (machine_id,))
    row = c.fetchone()
    conn.close()
    
    if not row:
        return jsonify({'error': '机子不存在'}), 404
    
    return jsonify({
        'id': row[0],
        'substation_id': row[1],
        'position_x': row[2],
        'position_y': row[3],
        'name': row[4] or '',
        'info': row[5] or '',
        'image_path': row[6] or ''
    })

@app.route('/api/machines/<int:machine_id>', methods=['PUT'])
def update_machine(machine_id):
    data = request.json
    name = data.get('name', '')
    info = data.get('info', '')
    image_data = data.get('image')
    
    conn = sqlite3.connect('data/substation.db')
    c = conn.cursor()
    
    # 获取现有数据
    c.execute('SELECT image_path FROM machines WHERE id = ?', (machine_id,))
    existing = c.fetchone()
    
    if not existing:
        conn.close()
        return jsonify({'error': '机子不存在'}), 404
    
    image_path = existing[0]
    
    # 如果有新图片，保存它
    if image_data:
        try:
            image_data = image_data.split(',')[1] if ',' in image_data else image_data
            image_bytes = base64.b64decode(image_data)
            filename = f"machine_{machine_id}_{datetime.now().strftime('%Y%m%d%H%M%S')}.jpg"
            image_path = os.path.join(app.config['UPLOAD_FOLDER'], filename)
            with open(image_path, 'wb') as f:
                f.write(image_bytes)
        except Exception as e:
            conn.close()
            return jsonify({'error': f'图片保存失败: {str(e)}'}), 500
    
    # 更新数据库
    c.execute('''UPDATE machines SET name = ?, info = ?, image_path = ?, 
                updated_at = CURRENT_TIMESTAMP WHERE id = ?''',
             (name, info, image_path, machine_id))
    
    conn.commit()
    conn.close()
    
    return jsonify({'success': True})

@app.route('/api/ocr', methods=['POST'])
def ocr_recognize():
    """OCR识别图片中的文字"""
    # 懒加载OCR
    ocr_reader = init_ocr()
    if not ocr_reader:
        return jsonify({'error': 'OCR功能未启用，请安装easyocr库: pip install easyocr'}), 503
    
    try:
        data = request.json
        image_data = data.get('image')
        
        if not image_data:
            return jsonify({'error': '未提供图片数据'}), 400
        
        # 解码base64图片
        image_data = image_data.split(',')[1] if ',' in image_data else image_data
        image_bytes = base64.b64decode(image_data)
        image = Image.open(io.BytesIO(image_bytes))
        
        # 使用EasyOCR识别
        results = ocr_reader.readtext(image)
        
        # 提取所有识别到的文本，按置信度排序
        text_items = []
        for (bbox, text, confidence) in results:
            if confidence > 0.3:  # 降低阈值以获取更多文本
                text_items.append((text.strip(), confidence))
        
        # 按位置排序（从上到下）
        if text_items:
            # 简单处理：按置信度排序，高置信度的优先
            text_items.sort(key=lambda x: x[1], reverse=True)
            all_text = [item[0] for item in text_items]
        else:
            all_text = []
        
        full_text = '\n'.join(all_text)
        
        # 尝试提取机子名称和信息
        machine_name = ''
        machine_info = full_text
        
        if all_text:
            # 查找包含关键词的行作为名称（优先级从高到低）
            name_keywords = [
                ['型号', 'Model'],
                ['编号', 'No.', 'NO.', '编号'],
                ['名称', 'Name'],
                ['设备', 'Equipment'],
                ['机', 'Machine'],
                ['变压器', 'Transformer'],
                ['开关', 'Switch'],
                ['断路器', 'Breaker']
            ]
            
            # 先查找包含高优先级关键词的行
            for keywords in name_keywords:
                for line in all_text:
                    if any(keyword in line for keyword in keywords):
                        machine_name = line.strip()
                        break
                if machine_name:
                    break
            
            # 如果没有找到，尝试提取第一行或最短的行作为名称
            if not machine_name:
                # 优先选择较短的行（可能是名称）
                short_lines = [line for line in all_text if len(line) <= 30]
                if short_lines:
                    machine_name = short_lines[0]
                elif all_text:
                    machine_name = all_text[0]
            
            # 其余内容作为详细信息
            if machine_name and machine_name in all_text:
                remaining = [line for line in all_text if line != machine_name]
                machine_info = '\n'.join(remaining).strip() if remaining else full_text
            else:
                if len(all_text) > 1:
                    machine_info = '\n'.join(all_text[1:]).strip()
                else:
                    machine_info = full_text
        
        return jsonify({
            'success': True,
            'full_text': full_text,
            'machine_name': machine_name,
            'machine_info': machine_info,
            'confidence': min([conf for _, _, conf in results] + [0.5])
        })
    
    except Exception as e:
        return jsonify({'error': f'OCR识别失败: {str(e)}'}), 500

@app.route('/uploads/<filename>')
def uploaded_file(filename):
    return send_from_directory(app.config['UPLOAD_FOLDER'], filename)

if __name__ == '__main__':
    # 方法B：使用自签证书启用 HTTPS（移动端摄像头通常要求 HTTPS 才能使用）
    # 首次访问可能会提示证书不受信任，选择“继续访问/高级”即可
    app.run(debug=True, host='0.0.0.0', port=5000, ssl_context='adhoc')
