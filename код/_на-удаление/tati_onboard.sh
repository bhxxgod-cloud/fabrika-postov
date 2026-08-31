#!/bin/bash
# ЗАВОД ТАТИ (владелец 05.08): дождаться конца люкс-волны → персона на фабрике → сцены →
# люкс-реф → волна шаблонов. Все шаги через один админ-профиль, поэтому строго после luxbatch.
cd "/Users/qq/Desktop/neironka-poster"

until grep -q "ЛЮКС-ВОЛНА ГОТОВА" /tmp/luxbatch.log 2>/dev/null; do sleep 60; done
echo "== luxbatch завершён, завожу Тати"

# 1. Персона на фабрике (UI: Личности → Добавить → имя + фото)
node tati_persona.cjs 2>&1 | tail -6

# 2. Сцены (пул базовых фото с её лицом)
node forestscenes.cjs 2>&1 | grep -E "Тати|ИТОГ" | tail -3

# 3. Люкс-реф её же движком
node luxrefs.cjs 2>&1 | grep -E "Тати|ИТОГ" | tail -3

# 4. Волна шаблонов по люкс-рефу
if [ -f "/tmp/luxrefs/Тати.jpg" ]; then
  for t in img-beauty-guide img-makeup-colortype img-face-report img-gelik-azs; do
    echo "=== Тати → $t"
    node genref.cjs "/tmp/luxrefs/Тати.jpg" "$t" --label "Тати" 2>&1 | grep -E "заказан|готов|проверка|ИТОГ|ОШИБКА" | tail -3
    sleep 15
  done
else
  echo "люкс-реф Тати не получился, волна по исходнику:"
  for t in img-beauty-guide img-face-report; do
    node genref.cjs "/Users/qq/Desktop/АВАТАРЫ /Тати/00_исходник.jpeg" "$t" --label "Тати" 2>&1 | grep -E "ИТОГ|ОШИБКА" | tail -2
    sleep 15
  done
fi
echo "ТАТИ ЗАВЕДЕНА"
