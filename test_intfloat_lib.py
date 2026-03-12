"""Library with int and float params for testing type narrowing."""


def paginate(items, page, per_page):
    start = (page - 1) * per_page
    end = start + per_page
    return {
        "items": items[start:end],
        "page": page,
        "per_page": per_page,
        "total": len(items),
    }


def calculate_stats(values, precision):
    mean = sum(values) / len(values)
    return {
        "mean": round(mean, precision),
        "count": len(values),
        "sum": sum(values),
    }


def mixed_types(name, age, score, active):
    return {
        "name": name,
        "age": age,
        "score": score,
        "active": active,
        "label": f"{name} ({age})",
    }


class UserService:
    def get_user(self, user_id, include_details):
        return {"id": user_id, "name": "Alice", "include_details": include_details}

    def list_users(self, offset, limit):
        return {"users": [{"id": 1, "name": "Alice"}], "offset": offset, "limit": limit, "total": 42}
