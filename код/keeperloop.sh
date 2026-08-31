#!/bin/bash
# Цикл смотрителя окна: после каждой генерации окно нейронки открывается снова.
cd "/Users/qq/Desktop/neironka-poster"
while true; do node genkeeper.cjs; sleep 15; done
