#ifndef UTIL_H
#define UTIL_H

int add(int a, int b);
int mul(int a, int b);

/* 函数式宏：展开后分别调用 add / mul */
#define CALC_SUM(a, b)  add((a), (b))
#define CALC_PROD(a, b) mul((a), (b))

/* 嵌套宏：展开后调用 CALC_SUM 与 CALC_PROD */
#define CALC_TOTAL(a, b) (CALC_SUM(a, b) + CALC_PROD(a, b))

#endif
