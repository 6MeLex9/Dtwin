import glob, os, re, sys
from PIL import Image

tmp = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.environ['TEMP'], 'dtwinqa')

BAD = ['undefined', 'NaN', 'Infinity', '[object Object]', 'null ₽', 'undefined ₽', '0.00e']

EXPECT = {
    'profile': ['Карта доступности', 'KL-24817', 'Покрытие профиля', 'Внутренний', 'Поведенческий',
                'Партнёрский', 'Внешний', 'Публичный', 'Типизированная пропущенность', 'Оффер'],
    'impute': ['Восстановленные значения', 'MICE', 'MNAR', 'Пробег', '90% ДИ', 'уверенность',
               'Детектор adversarial', 'Чувствительные признаки'],
    'twin': ['Нужны данные', 'Digital Twin', 'Альтернативы договора', 'Устойчивость выбора',
             'Что даст запрос данных', 'Как предположения попали в цену', 'Премиум'],
    'twinapi': ['Условный оффер', 'надбавка за неопределённость', 'Стандарт'],
    'feedback': ['Сравнение импутации с фактом', 'MAE', 'покрытие 90% ДИ', 'факт', 'недобор цены'],
    'risks': ['Ложная уверенность', 'Каскадная ошибка', 'Adversarial', 'Прокси-дискриминация',
              'Утечка через импутацию', 'Контрмеры', 'Аудит решений'],
    'newclient': ['Новый клиент для демонстрации', 'Готовые персоны', 'Молодой водитель', 'Курьер',
                  'Пенсионер', 'Свой вариант', 'Данные клиента', 'История отказов',
                  'Применить и пересчитать', 'Случайный из популяции', 'μ ']
}

print('=== DOM ===')
fails = 0
for f in sorted(glob.glob(os.path.join(tmp, 'dom-*.html'))):
    name = os.path.basename(f)[4:-5]
    html = open(f, encoding='utf-8', errors='replace').read()
    text = re.sub(r'<[^>]+>', ' ', html)
    text = re.sub(r'\s+', ' ', text)
    miss = [e for e in EXPECT.get(name, []) if e not in text]
    bad = {b: text.count(b) for b in BAD if b in text}
    print(f'{name:9s} len={len(text):6d}  missing={miss}  bad={bad}')
    if miss: fails += 1
    if bad: fails += 1

    # модальное окно клиента: открыто, форма полная
    if name == 'newclient':
        opened = 'class="modal on"' in html
        nf = len(re.findall(r'data-fid="', html))
        np = len(re.findall(r'data-preset="', html))
        warn = 'Проверьте ввод' in text or 'правдоподобных границах' in text
        print(f'          modal_open={opened} inputs={nf} presets={np} warn={warn}')
        if not (opened and nf == 14 and np == 6 and warn):
            fails += 1

    # согласованность: цена в баннере = итог разложения цены (или явная пометка «справочно»)
    ban = re.search(r'class="p">([^<]+)<', html)
    tot = re.search(r'(итог|справочно): <b>([^<]+)<', html)
    if ban and tot:
        pb, label, pt = ban.group(1).strip(), tot.group(1), tot.group(2).strip()
        if pb == '—':
            okk = label == 'справочно' and 'оффер не выставляется' in text
            print(f'          banner=—  explain={label}: {pt!r}  {"OK" if okk else "!! нет пометки справочно"}')
            if not okk: fails += 1
        else:
            okk = label == 'итог' and pb == pt
            print(f'          banner={pb!r}  explain={label}: {pt!r}  {"OK" if okk else "!! РАСХОЖДЕНИЕ"}')
            if not okk: fails += 1

print('\n=== PNG ===')
for f in sorted(glob.glob(os.path.join(tmp, 'shot-*.png'))):
    name = os.path.basename(f)[5:-4]
    im = Image.open(f).convert('RGB')
    w, h = im.size
    px = im.load()
    # области: шапка, рельс, сцена
    def stats(x0, y0, x1, y1):
        tot = 0; lit = 0; colors = set()
        for y in range(y0, min(y1, h), 3):
            for x in range(x0, min(x1, w), 3):
                r, g, b = px[x, y]
                tot += 1
                if abs(r - 14) > 26 or abs(g - 22) > 26 or abs(b - 38) > 26:
                    lit += 1
                colors.add((r // 8, g // 8, b // 8))
        return lit / max(tot, 1), len(colors)
    rail, c1 = stats(0, 60, 292, min(h, 1700))
    stage, c2 = stats(310, 60, w - 10, min(h, 1700))
    top, c3 = stats(0, 0, w, 56)
    print(f'{name:9s} {w}x{h}  rail={rail:6.2%} stage={stage:6.2%} top={top:6.2%}  colors rail={c1} stage={c2}')
    # при открытом модальном окне фон затемнён оверлеем — проверка заполненности неприменима
    domp = os.path.join(tmp, 'dom-' + name + '.html')
    overlay = os.path.exists(domp) and 'class="modal on"' in open(domp, encoding='utf-8', errors='replace').read()
    if overlay:
        print('          (модальное окно открыто — затемнение ожидаемо)')
    elif stage < 0.012:
        print('   !! сцена почти пустая'); fails += 1
    elif rail < 0.02:
        print('   !! рельс почти пустой'); fails += 1

print('\nпровалов:', fails)
sys.exit(1 if fails else 0)